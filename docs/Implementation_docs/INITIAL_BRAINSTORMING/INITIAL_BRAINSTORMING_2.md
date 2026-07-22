# Dreamer — DB & Dashboard Deep Dive (Continued)

---

## Part 3: Authentication Architecture (Production-Grade)

### The Token Strategy

Most tutorials implement a single JWT with a 7-day expiry and call it auth. That's a mistake for anything you're showing to engineers: if the token is stolen, the attacker has 7 days. The correct pattern is **short-lived access tokens + long-lived refresh tokens stored in an httpOnly cookie**.

```
Access Token:   15-minute expiry, stored in memory (React state / Zustand)
Refresh Token:  7-day expiry, stored in httpOnly cookie, hashed in DB
```

The access token never touches `localStorage` — XSS can't steal what isn't in the DOM. The refresh token in an httpOnly cookie is invisible to JavaScript — same protection. The DB stores only the **bcrypt hash** of the refresh token, so a DB breach doesn't let an attacker mint new sessions.

```typescript
// src/lib/auth/tokens.ts
import jwt from 'jsonwebtoken'
import bcrypt from 'bcrypt'
import crypto from 'crypto'

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!   // 256-bit random string
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET! // different 256-bit random string

export interface AccessTokenPayload {
  sub: string       // user ID
  email: string
  iat: number
  exp: number
}

export function signAccessToken(userId: string, email: string): string {
  return jwt.sign(
    { sub: userId, email },
    ACCESS_SECRET,
    { expiresIn: '15m', algorithm: 'HS256' }
  )
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload
}

export async function createRefreshToken(
  userId: string,
  ipAddress: string,
  userAgent: string
): Promise<{ token: string; sessionId: string }> {
  // Generate a cryptographically random refresh token
  const rawToken = crypto.randomBytes(64).toString('hex')
  const tokenHash = await bcrypt.hash(rawToken, 10)
  
  const session = await prisma.userSession.create({
    data: {
      userId,
      tokenHash,
      ipAddress,
      userAgent,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    }
  })
  
  return { token: rawToken, sessionId: session.id }
}

export async function rotateRefreshToken(
  rawToken: string,
  ipAddress: string,
  userAgent: string
): Promise<{ accessToken: string; refreshToken: string } | null> {
  // Find sessions that could match — we can't look up by raw token,
  // only by bcrypt comparison. Limit the search to recent, non-expired sessions.
  // In practice: encode the sessionId inside the refresh token itself.
  
  // Better pattern: JWT-style refresh token that encodes the sessionId
  // so we can do a DB lookup, then bcrypt verify
  
  // Decode the session ID from the token (first 36 chars = UUID)
  const sessionId = rawToken.slice(0, 36)
  const tokenPart = rawToken.slice(36)
  
  const session = await prisma.userSession.findFirst({
    where: {
      id: sessionId,
      expiresAt: { gt: new Date() }
    },
    include: { user: true }
  })
  
  if (!session) return null
  
  const isValid = await bcrypt.compare(tokenPart, session.tokenHash)
  if (!isValid) return null
  
  // Rotate: delete old session, create new one
  await prisma.userSession.delete({ where: { id: session.id } })
  
  const { token: newRefreshToken, sessionId: newSessionId } = 
    await createRefreshToken(session.userId, ipAddress, userAgent)
  
  const accessToken = signAccessToken(session.userId, session.user.email)
  
  // Update lastUsedAt on the new session
  await prisma.userSession.update({
    where: { id: newSessionId },
    data: { lastUsedAt: new Date() }
  })
  
  return { accessToken, refreshToken: newRefreshToken }
}
```

### Login Endpoint

```typescript
// src/routes/auth.route.ts
router.post('/login', rateLimiter({ max: 10, window: 60 }), async (req, res) => {
  const { email, password } = req.body
  
  const user = await prisma.user.findUnique({ where: { email } })
  
  // Constant-time comparison — always run bcrypt even if user doesn't exist
  // to prevent timing attacks revealing which emails are registered
  const dummyHash = '$2b$12$invalidhashfortimingnormalization'
  const isValid = user
    ? await bcrypt.compare(password, user.passwordHash)
    : await bcrypt.compare(password, dummyHash)
  
  if (!user || !isValid) {
    await prisma.auditLog.create({
      data: {
        action: 'user.login_failed',
        metadata: { email, reason: 'invalid_credentials' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      }
    })
    // Same error message regardless of whether the email exists
    return res.status(401).json({ error: 'Invalid email or password' })
  }
  
  if (!user.isActive) {
    return res.status(403).json({ error: 'Account suspended' })
  }
  
  const accessToken = signAccessToken(user.id, user.email)
  const { token: refreshToken } = await createRefreshToken(
    user.id,
    req.ip,
    req.headers['user-agent'] ?? ''
  )
  
  // Refresh token goes in httpOnly cookie
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/auth/refresh', // Cookie only sent to the refresh endpoint
  })
  
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() }
  })
  
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'user.login',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    }
  })
  
  return res.json({
    accessToken,
    user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl }
  })
})
```

### Auth Middleware

```typescript
// src/middleware/auth.middleware.ts
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization']
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' })
  }
  
  const token = authHeader.slice(7)
  
  try {
    const payload = verifyAccessToken(token)
    
    // Attach user to request — subsequent handlers just use req.user
    req.user = { id: payload.sub, email: payload.email }
    next()
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' })
    }
    return res.status(401).json({ error: 'Invalid token' })
  }
}
```

The `TOKEN_EXPIRED` error code matters: the frontend intercepts it, silently calls `POST /auth/refresh`, stores the new access token, and retries the original request — transparent to the user.

### Frontend Token Management (Zustand)

```typescript
// src/store/auth.store.ts
import { create } from 'zustand'

interface AuthState {
  accessToken: string | null
  user: User | null
  setTokens: (accessToken: string, user: User) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  setTokens: (accessToken, user) => set({ accessToken, user }),
  clearAuth: () => set({ accessToken: null, user: null }),
}))

// src/lib/api-client.ts
// Axios instance that auto-refreshes on 401
import axios from 'axios'

const apiClient = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL })

apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

let isRefreshing = false
let refreshQueue: Array<(token: string) => void> = []

apiClient.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config
    
    if (error.response?.data?.code === 'TOKEN_EXPIRED' && !original._retry) {
      original._retry = true
      
      if (isRefreshing) {
        // Queue subsequent requests while refresh is in-flight
        return new Promise((resolve) => {
          refreshQueue.push((token) => {
            original.headers.Authorization = `Bearer ${token}`
            resolve(apiClient(original))
          })
        })
      }
      
      isRefreshing = true
      
      try {
        // Cookie is sent automatically (credentials: 'include')
        const { data } = await axios.post('/auth/refresh', {}, { withCredentials: true })
        useAuthStore.getState().setTokens(data.accessToken, data.user)
        
        refreshQueue.forEach(cb => cb(data.accessToken))
        refreshQueue = []
        
        original.headers.Authorization = `Bearer ${data.accessToken}`
        return apiClient(original)
      } catch {
        useAuthStore.getState().clearAuth()
        window.location.href = '/login'
      } finally {
        isRefreshing = false
      }
    }
    
    return Promise.reject(error)
  }
)
```

---

## Part 4: GitHub Webhook Handler (Production-Grade)

This enables auto-deploy on push. Every `git push` to main triggers a new deployment without touching the dashboard.

```typescript
// src/routes/webhook.route.ts
import crypto from 'crypto'

router.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
  // 1. Validate the HMAC signature GitHub sends
  const signature = req.headers['x-hub-signature-256'] as string
  if (!signature) return res.status(401).end()
  
  // Find which project this webhook belongs to — via the repository full_name
  const payload = JSON.parse(req.body.toString())
  const repoFullName = payload.repository?.full_name
  if (!repoFullName) return res.status(400).end()
  
  const project = await prisma.project.findFirst({
    where: { repoFullName, deletedAt: null }
  })
  if (!project || !project.webhookSecret) return res.status(404).end()
  
  // Decrypt the webhook secret and verify HMAC
  const webhookSecret = decrypt(project.webhookSecret, project.webhookSecretIv!)
  const hmac = crypto.createHmac('sha256', webhookSecret)
  const digest = `sha256=${hmac.update(req.body).digest('hex')}`
  
  // Timing-safe comparison — prevents timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
    return res.status(401).json({ error: 'Invalid signature' })
  }
  
  // 2. Acknowledge immediately — GitHub will retry if we don't respond in 10s
  res.status(200).json({ received: true })
  
  // 3. Process asynchronously
  const event = req.headers['x-github-event'] as string
  const deliveryId = req.headers['x-github-delivery'] as string
  
  if (event !== 'push') return // Only handle push events for now
  
  const branch = payload.ref?.replace('refs/heads/', '')
  const commitHash = payload.after
  const commitMessage = payload.commits?.[0]?.message
  const commitAuthor = payload.commits?.[0]?.author?.name
  
  // Record the delivery
  const delivery = await prisma.webhookDelivery.create({
    data: {
      projectId: project.id,
      githubDeliveryId: deliveryId,
      event: 'PUSH',
      branch,
      commitHash,
      commitMessage,
      rawPayload: payload,
    }
  })
  
  // Only auto-deploy pushes to the watched branch
  if (branch !== project.defaultBranch) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { skipReason: `branch '${branch}' not watched (watching '${project.defaultBranch}')` }
    })
    return
  }
  
  // Don't queue if already building
  const inProgress = await prisma.deployment.findFirst({
    where: {
      projectId: project.id,
      status: { in: ['QUEUED', 'BUILDING', 'UPLOADING', 'STARTING'] }
    }
  })
  
  if (inProgress) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { skipReason: `deployment ${inProgress.id} already in progress` }
    })
    return
  }
  
  // Trigger deployment
  const deployment = await prisma.deployment.create({
    data: {
      projectId: project.id,
      slug: generateSlug(),
      branch,
      commitHash,
      commitMessage,
      commitAuthor,
      triggeredBy: 'webhook',
      webhookDeliveryId: delivery.id,
      status: 'QUEUED',
    }
  })
  
  await buildQueue.add('build', {
    deploymentId: deployment.id,
    projectId: project.id,
    repoUrl: project.repoUrl,
    slug: deployment.slug,
    branch,
    commitHash,
  })
  
  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: { deploymentTriggered: true, deploymentId: deployment.id }
  })
})
```

---

## Part 5: Observability

A resume project that has metrics and structured logging is genuinely rare. It takes an afternoon to add and signals production engineering maturity.

### Structured Logging (Pino)

Replace `console.log` everywhere with Pino. Every log line is a JSON object with consistent fields:

```typescript
// src/lib/logger.ts
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'dreamer-api',
    version: process.env.npm_package_version,
    env: process.env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // In production, output raw JSON. In development, pretty-print.
  ...(process.env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { colorize: true } }
  }),
})

// Usage throughout the codebase:
logger.info({ deploymentId, projectId, slug }, 'Deployment queued')
logger.error({ err, deploymentId }, 'ECS task failed to start')
logger.warn({ userId, ipAddress }, 'Rate limit hit on /auth/login')
```

Every log line carries the relevant IDs as structured fields — searchable in CloudWatch or Datadog without parsing strings.

### HTTP Request Logging Middleware

```typescript
// src/middleware/request-logger.middleware.ts
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now()
  const requestId = crypto.randomUUID()
  
  req.requestId = requestId
  res.setHeader('X-Request-Id', requestId)
  
  res.on('finish', () => {
    const duration = Date.now() - start
    
    logger.info({
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
      userId: req.user?.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }, 'HTTP request')
  })
  
  next()
}
```

### Health Check Endpoint

```typescript
// GET /health — used by ECS health checks, load balancers, uptime monitors
router.get('/health', async (req, res) => {
  const [dbOk, redisOk] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    redis.ping(),
  ])
  
  const healthy = dbOk.status === 'fulfilled' && redisOk.status === 'fulfilled'
  
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks: {
      database: dbOk.status === 'fulfilled' ? 'ok' : 'error',
      redis: redisOk.status === 'fulfilled' ? 'ok' : 'error',
    },
    version: process.env.npm_package_version,
    uptime: process.uptime(),
  })
})
```

### Prometheus Metrics (Optional P3, High Impact)

```typescript
// src/lib/metrics.ts
import { Registry, Counter, Histogram, Gauge } from 'prom-client'

const register = new Registry()

export const metrics = {
  deploymentsTotal: new Counter({
    name: 'dreamer_deployments_total',
    help: 'Total deployment attempts',
    labelNames: ['status', 'framework', 'type'],
    registers: [register],
  }),
  buildDuration: new Histogram({
    name: 'dreamer_build_duration_seconds',
    help: 'Build duration in seconds',
    buckets: [10, 30, 60, 120, 180, 300, 600],
    labelNames: ['framework'],
    registers: [register],
  }),
  activeDeployments: new Gauge({
    name: 'dreamer_active_deployments',
    help: 'Currently running deployments',
    labelNames: ['type'],
    registers: [register],
  }),
  sleepingDeployments: new Gauge({
    name: 'dreamer_sleeping_deployments',
    help: 'Deployments currently sleeping (scale-to-zero)',
    registers: [register],
  }),
  queueDepth: new Gauge({
    name: 'dreamer_build_queue_depth',
    help: 'Number of jobs waiting in the build queue',
    registers: [register],
  }),
}

// GET /metrics — scraped by Prometheus
router.get('/metrics', async (req, res) => {
  res.setHeader('Content-Type', register.contentType)
  res.end(await register.metrics())
})
```

---

## Part 6: Repository Structure (Final)

```
dreamer/
├── apps/
│   ├── api/                          # Express API server
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── auth.route.ts
│   │   │   │   ├── projects.route.ts
│   │   │   │   ├── deployments.route.ts
│   │   │   │   ├── env-variables.route.ts
│   │   │   │   ├── custom-domains.route.ts
│   │   │   │   ├── webhook.route.ts
│   │   │   │   └── health.route.ts
│   │   │   ├── middleware/
│   │   │   │   ├── auth.middleware.ts
│   │   │   │   ├── rate-limiter.middleware.ts
│   │   │   │   └── request-logger.middleware.ts
│   │   │   ├── services/
│   │   │   │   ├── deployment-state.service.ts
│   │   │   │   ├── ecs.service.ts
│   │   │   │   ├── ecr.service.ts
│   │   │   │   └── alb.service.ts
│   │   │   ├── workers/
│   │   │   │   ├── build.worker.ts
│   │   │   │   ├── idle-detector.worker.ts
│   │   │   │   ├── sleep.worker.ts
│   │   │   │   ├── wake.worker.ts
│   │   │   │   └── log-retention.worker.ts
│   │   │   ├── engines/
│   │   │   │   ├── engine.interface.ts
│   │   │   │   ├── cloud.engine.ts
│   │   │   │   └── bare-metal.engine.ts
│   │   │   ├── lib/
│   │   │   │   ├── logger.ts
│   │   │   │   ├── redis.ts
│   │   │   │   ├── crypto.ts
│   │   │   │   ├── metrics.ts
│   │   │   │   └── auth/
│   │   │   │       └── tokens.ts
│   │   │   ├── db/
│   │   │   │   ├── client.ts
│   │   │   │   └── queries/
│   │   │   │       ├── projects.ts
│   │   │   │       ├── deployments.ts
│   │   │   │       └── logs.ts
│   │   │   └── index.ts
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── build-server/                 # ECS task: clone + build + push/upload
│   │   ├── src/
│   │   │   ├── index.ts              # Entry: reads env vars, calls engine
│   │   │   ├── framework-detector.ts
│   │   │   ├── static-builder.ts     # npm build + S3 sync
│   │   │   ├── dynamic-builder.ts    # docker build + ECR push
│   │   │   └── log-publisher.ts      # Redis pub/sub log lines
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── reverse-proxy/                # Subdomain router
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── wake-proxy.ts         # Sleep/wake interceptor
│   │   │   └── wake-page.html        # Loading page served to browsers
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── frontend/                     # Next.js dashboard
│       ├── app/
│       │   ├── (auth)/
│       │   │   ├── login/page.tsx
│       │   │   └── register/page.tsx
│       │   ├── (dashboard)/
│       │   │   ├── layout.tsx
│       │   │   ├── page.tsx
│       │   │   └── projects/
│       │   │       ├── new/page.tsx
│       │   │       └── [projectId]/
│       │   │           ├── page.tsx
│       │   │           ├── deployments/
│       │   │           │   ├── page.tsx
│       │   │           │   └── [deploymentId]/page.tsx
│       │   │           └── settings/
│       │   │               ├── page.tsx
│       │   │               ├── env/page.tsx
│       │   │               ├── domains/page.tsx
│       │   │               └── danger/page.tsx
│       │   └── api/
│       ├── components/
│       │   ├── ui/
│       │   │   ├── StatusBadge.tsx
│       │   │   ├── LogStream.tsx
│       │   │   ├── StateTimeline.tsx
│       │   │   └── FrameworkIcon.tsx
│       │   ├── projects/
│       │   └── deployments/
│       ├── store/
│       │   └── auth.store.ts
│       ├── lib/
│       │   └── api-client.ts
│       └── package.json
│
├── infra/                            # AWS CDK or Terraform
│   ├── ecs-cluster.ts
│   ├── ecr-repos.ts
│   ├── alb.ts
│   ├── rds.ts
│   └── redis.ts
│
├── docker-compose.yml                # Local dev: postgres + redis
├── turbo.json                        # Turborepo config
└── package.json                      # Monorepo root
```

---

## Part 7: Local Development Setup

```yaml
# docker-compose.yml — spins up postgres and redis for local dev
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: dreamer
      POSTGRES_USER: dreamer
      POSTGRES_PASSWORD: dreamer_local
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

```bash
# .env.example — committed to git, actual .env is gitignored
DATABASE_URL="postgresql://dreamer:dreamer_local@localhost:5432/dreamer?schema=public"
REDIS_URL="redis://localhost:6379"

# Auth
JWT_ACCESS_SECRET=""        # node -e "require('crypto').randomBytes(32).toString('hex')"
JWT_REFRESH_SECRET=""       # different from access secret
ENCRYPTION_KEY=""           # node -e "require('crypto').randomBytes(32).toString('hex')"

# AWS
AWS_REGION="ap-south-1"
AWS_ACCESS_KEY_ID=""
AWS_SECRET_ACCESS_KEY=""
ECS_CLUSTER=""
ECS_BUILD_TASK_DEFINITION=""
ECR_REGISTRY=""
S3_BUCKET="dreamer-outputs"
ALB_LISTENER_ARN=""
SUBNETS=""                  # comma-separated subnet IDs
SG_BUILD=""                 # security group for build tasks
SG_DYNAMIC_APPS=""          # security group for dynamic app tasks

# Platform
BASE_DOMAIN="dreamer.yourdomain.com"
NODE_ENV="development"
LOG_LEVEL="debug"
DEPLOYMENT_ENVIRONMENT="cloud"  # or "bare_metal"
```
