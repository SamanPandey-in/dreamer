# Dreamer — Full Project Analysis & Improvement Guide

---

## Part 1: What's Actually Built vs. What's Designed

### What Exists (Current Implementation)

Your codebase has four components:

**api-server/index.js**
- Express server on port 9000 with a single route: `POST /project`
- Accepts `gitURL` and optional `slug`, generates a random word slug if none provided
- Fires an ECS `RunTaskCommand` (Fargate) to spin a build container
- Returns `{ status: 'queued', data: { projectSlug, url } }` immediately — this is correct async behavior
- Socket.io server on port 9002 for real-time log relay
- Redis pub/sub subscriber that listens on `logs:*` pattern and forwards to Socket.io rooms

**build-server/script.js + main.sh + Dockerfile**
- Ubuntu:focal base image with Node 20 installed via curl (not slim — bloated)
- `main.sh`: clones the git repo into `/home/app/output`, then runs `node script.js`
- `script.js`: runs `npm install && npm run build` inside output dir, uploads `dist/` to S3 via `PutObjectCommand`, publishes log lines to Redis channel `logs:{PROJECT_ID}`
- Hardcoded S3 bucket name `vercel-clone-outputs`, hardcoded S3 key prefix `__outputs`

**s3-reverse-proxy/index.js**
- Express server on port 8000
- Extracts subdomain from hostname, proxies to `https://vercel-clone-outputs.s3.ap-south-1.amazonaws.com/__outputs/{subdomain}/`
- Appends `index.html` if path is `/`

**frontend-nextjs/app/page.tsx**
- Single page, no routing, no auth
- GitHub URL input with regex validation
- Calls `POST localhost:9000/project` on deploy
- Subscribes to Socket.io channel `logs:{projectSlug}` for real-time build logs
- Shows a preview URL (points to `localhost:8000` — not production)
- Log container renders the streamed lines

---

### What Is Complete

| Feature | Status | Notes |
|---|---|---|
| Git repo ingestion | ✅ Works | `main.sh` clones the repo |
| Build execution | ✅ Works | `npm install && npm run build` |
| S3 upload of dist/ | ✅ Works | Uploads all files in dist/ with correct MIME types |
| S3 reverse proxy | ✅ Works | Proxies subdomain → S3 path |
| Redis log pub/sub | ✅ Works | Build server publishes, API server relays |
| Real-time log streaming | ✅ Works | Via Socket.io to frontend |
| ECS Fargate build dispatch | ✅ Works | RunTaskCommand with env var overrides |
| Basic frontend UI | ✅ Works | Single page, minimal |

---

### What Is Missing or Broken

**No authentication at all.** Anyone who knows the API endpoint can deploy to your infrastructure. No user model, no JWT, no session — the entire platform is public.

**No database.** There is no persistence of any kind. When a build finishes, you have no record of what was deployed, what the URL was, what the status was, or any history. The frontend must remember the slug in memory. Refresh the page and the deployment is forgotten.

**No deployment state machine.** The API returns `{ status: 'queued' }` but never updates it. There is no `building`, `running`, `failed` state tracked anywhere. The frontend has no way to know if the deployment succeeded beyond reading logs.

**Static-only builds hardcoded.** `script.js` always looks for a `dist/` folder. If a user deploys a Next.js SSR app, an Express API, or any app that doesn't produce a `dist/` folder, the upload silently fails or errors. There is no framework detection.

**No dynamic app support.** The entire architecture assumes static output → S3. There is no path for Node/Express/Next.js SSR deployments that need a running container.

**Credentials hardcoded as empty strings.** `accessKeyId: ''`, `secretAccessKey: ''`, ECS cluster and task as `''`. This must be environment-variable driven before any deployment.

**Preview URL points to localhost.** `url: \`http://${projectSlug}.localhost:8000\`` is returned to the client. This is a local dev URL, not a public live link for your resume.

**No BullMQ queue.** The API fires ECS directly and returns. There is no retry logic, no job priority, no backpressure, no visibility into queue depth. If ECS fails to start, the build is silently lost.

**No concurrent build limiting.** Nothing prevents 100 simultaneous Fargate tasks from spawning, which would be a significant AWS bill.

**No scale-to-zero / sleep mechanism.** All deployments (once dynamic apps are added) run 24/7.

**No rollback capability.** No version history, no way to revert.

**No GitHub webhook / auto-deploy.** Manual deploys only.

**No custom domain support.** All URLs are platform subdomains.

**No environment variable injection.** Users can't provide `DATABASE_URL`, `API_KEY`, etc.

**Frontend is a single unrouted page.** No dashboard, no project list, no deployment history view, no auth pages.

**Socket.io instead of SSE.** SSE is simpler, lower overhead, works over HTTP/1.1, and auto-reconnects. Socket.io adds 40KB of client JS and a separate port (9002) for something that is fundamentally one-directional streaming.

---

## Part 2: Architectural Upgrades — The Complete Improvement Plan

This is structured in phases so you can ship incrementally and have something live on your resume at each step.

---

### Phase A: Make It Actually Deployable (Week 1-2)

Before anything else, you need a real live link. Right now nothing is production-deployable due to the hardcoded credentials and localhost URLs.

**Environment variable extraction.** Move every credential and config value to `.env`:

```bash
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-south-1
ECS_CLUSTER=
ECS_TASK_DEFINITION=
ECS_SUBNET_1=
ECS_SUBNET_2=
ECS_SUBNET_3=
ECS_SECURITY_GROUP=
S3_BUCKET=dreamer-outputs
REDIS_URL=redis://localhost:6379
BASE_DOMAIN=dreamer.yourdomain.com
```

**Fix the preview URL.** Change `http://${projectSlug}.localhost:8000` to `http://${projectSlug}.${process.env.BASE_DOMAIN}`. The reverse proxy must be deployed on a real server with a wildcard DNS record (`*.singularitydev.xyz → server IP`).

**Fix the build server Dockerfile.** Swap `ubuntu:focal` for `node:20-alpine` — it's 10x smaller and builds faster on ECR push:

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache git bash
WORKDIR /home/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN chmod +x main.sh
ENTRYPOINT ["/home/app/main.sh"]
```

**Add status update calls from the build server.** The build server currently only publishes logs to Redis. It should also publish status transitions:

```javascript
// In script.js
function publishStatus(status, meta = {}) {
    publisher.publish(`status:${PROJECT_ID}`, JSON.stringify({ status, ...meta }))
}

// At build start:
publishStatus('building')
// After S3 upload complete:
publishStatus('running', { url: `https://${PROJECT_ID}.dreamer.yourdomain.com` })
// On error:
publishStatus('failed', { error: err.message })
```

The API server subscribes to `status:*` and updates the DB (once you add one).

---

### Phase B: Add Persistence + Auth (Week 2-3)

**Add PostgreSQL + Prisma.** This is non-negotiable for a resume project. The schema:

```prisma
model User {
  id          String       @id @default(uuid())
  email       String       @unique
  password    String       // bcrypt hash
  projects    Project[]
  createdAt   DateTime     @default(now())
}

model Project {
  id          String       @id @default(uuid())
  userId      String
  user        User         @relation(fields: [userId], references: [id])
  name        String
  repoUrl     String
  deployments Deployment[]
  createdAt   DateTime     @default(now())
}

model Deployment {
  id          String   @id @default(uuid())
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id])
  slug        String   @unique  // the subdomain
  status      String   @default("queued")  // queued|building|running|failed|stopped|sleeping
  url         String?
  errorMsg    String?
  ecsTaskArn  String?  // store so you can stop it later
  framework   String?  // detected: react|next|node|static
  deployedAt  DateTime @default(now())
}
```

**Add JWT auth.** Three routes: `POST /auth/register`, `POST /auth/login`, `GET /auth/me`. Standard bcrypt + JWT. Every other route requires `Authorization: Bearer <token>`.

**Update `POST /project` to `POST /projects/:id/deploy`** — this becomes a proper deployment trigger that: creates a `Deployment` record, enqueues a job, returns `202 Accepted` with the deployment ID.

---

### Phase C: BullMQ Queue Layer (Week 3)

Right now ECS is fired directly from the HTTP handler. This means no retry, no backpressure, no rate limiting, no visibility. Replace this with a proper queue:

```javascript
// queue.js
const { Queue } = require('bullmq')
const { Redis } = require('ioredis')

const connection = new Redis(process.env.REDIS_URL)
const buildQueue = new Queue('builds', { connection })

async function enqueueDeployment({ deploymentId, projectId, repoUrl, slug }) {
    return buildQueue.add('build', 
        { deploymentId, projectId, repoUrl, slug },
        {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 200 },
        }
    )
}
```

```javascript
// worker.js — this replaces the direct ECS call in the API server
const { Worker } = require('bullmq')

const worker = new Worker('builds', async (job) => {
    const { deploymentId, repoUrl, slug } = job.data
    
    await updateDeploymentStatus(deploymentId, 'building')
    
    const taskArn = await launchECSTask({ repoUrl, projectId: slug })
    await db.deployment.update({
        where: { id: deploymentId },
        data: { ecsTaskArn: taskArn }
    })
    
    // The ECS task publishes status updates back via Redis
    // Worker just needs to launch — status tracking is event-driven
}, { connection, concurrency: 5 }) // max 5 concurrent ECS builds
```

The `concurrency: 5` on the worker is your rate limiter — no matter how many deploys are triggered, at most 5 ECS Fargate tasks run simultaneously.

**Add Bull Board for visibility:**

```javascript
const { createBullBoard } = require('@bull-board/api')
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter')
const { ExpressAdapter } = require('@bull-board/express')

const serverAdapter = new ExpressAdapter()
serverAdapter.setBasePath('/admin/queues')

createBullBoard({
    queues: [new BullMQAdapter(buildQueue)],
    serverAdapter,
})

app.use('/admin/queues', authMiddleware, serverAdapter.getRouter())
```

This gives you a live dashboard at `/admin/queues` showing pending/active/completed/failed jobs — impressive to show recruiters.

---

### Phase D: Framework Detection + Static vs Dynamic Split (Week 4)

This is the most architecturally significant upgrade. Currently everything is assumed to be a static build → S3. You need to detect the framework and take two completely different paths.

**Framework detector (runs inside the ECS container after clone):**

```javascript
// framework-detector.js
const fs = require('fs')
const path = require('path')

function detectFramework(dir) {
    const pkgPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgPath)) {
        return fs.existsSync(path.join(dir, 'index.html')) ? 'static' : 'unknown'
    }
    
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    
    // Order matters — Next before React
    if (deps['next']) {
        // Check if it uses output: 'export' (static) or SSR
        const nextConfig = readNextConfig(dir)
        return nextConfig?.output === 'export' ? 'next-static' : 'next-ssr'
    }
    if (deps['react'] || deps['vite']) return 'react-static'
    if (deps['vue']) return 'vue-static'
    if (deps['svelte']) return 'svelte-static'
    if (deps['express'] || deps['fastify'] || deps['hono']) return 'node-dynamic'
    
    return 'node-dynamic' // default: assume it has a start script
}

function getOutputDir(framework) {
    const map = {
        'react-static': 'build',      // CRA
        'vue-static': 'dist',
        'svelte-static': 'build',
        'next-static': 'out',
        'next-ssr': null,             // no static output
        'node-dynamic': null,
    }
    // Also check Vite config for custom outDir
    return map[framework] ?? 'dist'
}
```

**Updated build flow in script.js:**

```javascript
async function init() {
    const framework = detectFramework(outDirPath)
    publishLog(`Detected framework: ${framework}`)
    publishStatus('building', { framework })
    
    // Install
    await exec(`cd ${outDirPath} && npm ci`)
    
    const isStatic = framework.endsWith('-static') || framework === 'static'
    const isDynamic = framework === 'next-ssr' || framework === 'node-dynamic'
    
    if (isStatic) {
        // Build and upload to S3 — existing path
        await exec(`cd ${outDirPath} && npm run build`)
        const outputDir = getOutputDir(framework)
        await uploadToS3(outDirPath, outputDir, PROJECT_ID)
        publishStatus('running', { 
            url: `https://${PROJECT_ID}.dreamer.yourdomain.com`,
            type: 'static'
        })
    }
    
    if (isDynamic) {
        // Build Docker image and push to ECR, then run on ECS
        await buildAndPushDockerImage(outDirPath, PROJECT_ID)
        const serviceArn = await createECSService(PROJECT_ID)
        publishStatus('running', {
            url: `https://${PROJECT_ID}.dreamer.yourdomain.com`,
            type: 'dynamic',
            ecsServiceArn: serviceArn
        })
    }
}
```

---

### Phase E: Dynamic App Infrastructure on AWS (Week 4-5)

For dynamic apps (Next.js SSR, Express, etc.), you need a persistent container path. The architecture:

```
User Request → Route53 wildcard → ALB → ECS Service (target group per deployment)
```

**Per-deployment ECS Service instead of RunTask:**

For static builds, you use `RunTaskCommand` (one-shot). For dynamic apps, you need `CreateServiceCommand` which keeps a task running with health checks and auto-restart:

```javascript
async function createECSServiceForDeployment(deploymentId, imageUri) {
    const ecs = new ECSClient({ region: process.env.AWS_REGION })
    
    // 1. Create a target group for this deployment
    const tg = await createTargetGroup(deploymentId)  // via ELBv2 SDK
    
    // 2. Add ALB listener rule: host header = deploymentId.dreamer.com → tg
    await addListenerRule(deploymentId, tg.TargetGroupArn)
    
    // 3. Create ECS service that maintains 1 running task
    await ecs.send(new CreateServiceCommand({
        cluster: process.env.ECS_CLUSTER,
        serviceName: `dreamer-${deploymentId}`,
        taskDefinition: await registerTaskDef(deploymentId, imageUri),
        desiredCount: 1,
        launchType: 'FARGATE',
        loadBalancers: [{
            targetGroupArn: tg.TargetGroupArn,
            containerName: 'app',
            containerPort: 3000
        }],
        networkConfiguration: {
            awsvpcConfiguration: {
                subnets: process.env.SUBNETS.split(','),
                securityGroups: [process.env.SG_DYNAMIC_APPS],
                assignPublicIp: 'DISABLED'
            }
        }
    }))
}
```

**Per-deployment Docker image in ECR:**

The build server, after detecting a dynamic framework, builds a Docker image from the cloned repo and pushes it to ECR:

```javascript
async function buildAndPushDockerImage(repoDir, deploymentId) {
    const imageUri = `${process.env.ECR_REGISTRY}/dreamer-apps:${deploymentId}`
    
    // Generate a Dockerfile if one doesn't exist
    if (!fs.existsSync(path.join(repoDir, 'Dockerfile'))) {
        fs.writeFileSync(path.join(repoDir, 'Dockerfile'), generateDockerfile(framework))
    }
    
    await exec(`docker build -t ${imageUri} ${repoDir}`)
    await exec(`aws ecr get-login-password | docker login --username AWS --password-stdin ${process.env.ECR_REGISTRY}`)
    await exec(`docker push ${imageUri}`)
    
    return imageUri
}

function generateDockerfile(framework) {
    if (framework === 'next-ssr') {
        return `
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
`
    }
    if (framework === 'node-dynamic') {
        return `
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
`
    }
}
```

---

### Phase F: Scale-to-Zero for Dynamic Apps (Week 5-6)

This is the most architecturally impressive feature. It mirrors what Vercel does for serverless functions and Railway does for sleeping services. Here's the complete design:

#### The Four Sub-Problems

**1. Idle Detection**

A BullMQ repeatable job runs every 60 seconds and scans all `RUNNING` dynamic deployments. For each one, it checks a Redis key `lastRequestAt:{deploymentId}` — a timestamp the reverse proxy stamps on every forwarded request:

```javascript
// idle-detector.job.js
const IDLE_THRESHOLD_MS = 15 * 60 * 1000 // 15 minutes

async function checkIdleDeployments() {
    const runningDeployments = await db.deployment.findMany({
        where: { status: 'running', type: 'dynamic' }
    })
    
    const keys = runningDeployments.map(d => `lastRequestAt:${d.id}`)
    const timestamps = await redis.mget(...keys)
    
    for (let i = 0; i < runningDeployments.length; i++) {
        const deployment = runningDeployments[i]
        const lastSeen = timestamps[i] ? parseInt(timestamps[i]) : deployment.deployedAt.getTime()
        const idleMs = Date.now() - lastSeen
        
        if (idleMs > IDLE_THRESHOLD_MS) {
            await sleepQueue.add('sleep', { deploymentId: deployment.id })
        }
    }
}

// Register as repeatable:
await sleepQueue.add('idle-check', {}, { 
    repeat: { every: 60_000 },
    jobId: 'idle-detector'
})
```

**2. Sleep Mechanism**

Sleeping a dynamic deployment means scaling the ECS service to 0. This keeps the service definition (target group, listener rules, task definition) intact — waking up is just scaling back to 1:

```javascript
// sleep.worker.js
async function sleepDeployment(deploymentId) {
    const deployment = await db.deployment.findUnique({ where: { id: deploymentId } })
    if (deployment.status !== 'running') return // race condition guard
    
    // Atomically update container state in Redis first (prevents thundering herd on wake)
    await redis.set(`containerState:${deploymentId}`, 'sleeping', 'EX', 86400)
    
    // Scale ECS service to 0
    await ecs.send(new UpdateServiceCommand({
        cluster: process.env.ECS_CLUSTER,
        service: `dreamer-${deploymentId}`,
        desiredCount: 0
    }))
    
    // Update DB
    await db.deployment.update({
        where: { id: deploymentId },
        data: { status: 'sleeping' }
    })
    
    publishLog(deploymentId, 'Deployment put to sleep after 15 minutes of inactivity')
    console.log(`[sleep] ${deploymentId} → sleeping`)
}
```

**3. Wake Mechanism — The Wake-Up Proxy**

This is the hardest part. When a request arrives for a sleeping deployment, you can't just drop it — the user will see a connection error. You need a **Wake-Up Proxy** that intercepts the request, wakes the container, and holds the connection until the container is ready.

The key insight: check `containerState:{id}` in Redis before proxying. This is a fast in-memory lookup that avoids hitting ECS on every request:

```javascript
// wake-proxy.middleware.js  (runs in the reverse proxy)

app.use(async (req, res) => {
    const deploymentId = extractDeploymentId(req.hostname)  // subdomain
    
    // Stamp the last-seen timestamp for idle detection
    await redis.set(`lastRequestAt:${deploymentId}`, Date.now(), 'EX', 86400)
    
    const containerState = await redis.get(`containerState:${deploymentId}`)
    
    if (containerState === 'sleeping') {
        await handleWakeUp(req, res, deploymentId)
        return
    }
    
    // Normal proxy to ALB / running container
    return proxy.web(req, res, { target: getTargetUrl(deploymentId) })
})

async function handleWakeUp(req, res, deploymentId) {
    // Prevent thundering herd: only one wake job per deployment
    const alreadyWaking = await redis.set(
        `waking:${deploymentId}`, '1', 'NX', 'EX', 120
    )
    
    if (alreadyWaking) {
        // First request wakes the container
        await wakeQueue.add('wake', { deploymentId }, { jobId: `wake-${deploymentId}` })
    }
    
    const acceptsHtml = req.headers['accept']?.includes('text/html')
    
    if (acceptsHtml) {
        // Browser client: serve a loading page with JS polling
        res.setHeader('Content-Type', 'text/html')
        res.send(generateWakeUpPage(deploymentId))
    } else {
        // API client (curl, mobile app, fetch): return 503 with Retry-After
        res.setHeader('Retry-After', '30')
        res.status(503).json({ 
            error: 'Service starting', 
            message: 'This deployment was sleeping. Retry in ~30 seconds.',
            deploymentId
        })
    }
}

function generateWakeUpPage(deploymentId) {
    return `<!DOCTYPE html>
<html>
<head>
  <title>Waking up...</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; 
           align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
    .container { text-align: center; }
    .spinner { width: 40px; height: 40px; border: 3px solid #333; 
               border-top-color: #6366f1; border-radius: 50%; 
               animation: spin 1s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h2>Waking up your deployment...</h2>
    <p>This service was sleeping. It'll be ready in ~15-30 seconds.</p>
  </div>
  <script>
    // Poll every 3 seconds to check if the service is awake
    async function checkStatus() {
      try {
        const r = await fetch('/api/wake-status/${deploymentId}')
        const data = await r.json()
        if (data.status === 'running') {
          window.location.reload()
        }
      } catch(e) {}
    }
    setInterval(checkStatus, 3000)
  </script>
</body>
</html>`
}
```

**4. Wake Worker**

```javascript
// wake.worker.js
async function wakeDeployment(deploymentId) {
    console.log(`[wake] Waking ${deploymentId}`)
    
    // Scale ECS service back to 1
    await ecs.send(new UpdateServiceCommand({
        cluster: process.env.ECS_CLUSTER,
        service: `dreamer-${deploymentId}`,
        desiredCount: 1
    }))
    
    await db.deployment.update({
        where: { id: deploymentId },
        data: { status: 'starting' }
    })
    
    // Poll until the ECS service is stable (task healthy)
    await waitUntilServiceStable(deploymentId)  // polls every 5s, timeout 120s
    
    // Update Redis state so proxy starts forwarding normally
    await redis.set(`containerState:${deploymentId}`, 'running')
    await redis.del(`waking:${deploymentId}`)
    
    await db.deployment.update({
        where: { id: deploymentId },
        data: { status: 'running' }
    })
    
    console.log(`[wake] ${deploymentId} → running`)
}
```

**The thundering herd prevention** is critical. If 100 users hit a sleeping deployment simultaneously, you don't want 100 ECS `UpdateService` calls. The `SET waking:{id} NX` (Set if Not Exists) ensures only the first request creates the wake job. All subsequent requests get the loading page while the single wake job does its work.

**Cold start latency reality check:** On ECS Fargate, `desiredCount: 0 → 1` takes 15-30 seconds because Fargate provisions a fresh microVM, pulls the image from ECR, runs health checks. This is the fundamental tradeoff. Mitigation strategies:
- Pre-pull your base images on warm Fargate capacity reservations
- Use smaller images (alpine base, multi-stage builds) to reduce pull time
- Cache the ECR image layer sizes — a 50MB image pulls in ~3s, a 500MB image takes 25s

#### Scale-to-Zero State Machine

```
RUNNING → (idle for 15min) → SLEEPING
SLEEPING → (request arrives, wake job triggered) → STARTING
STARTING → (ECS service stable, health check passes) → RUNNING
RUNNING → (new deploy) → STOPPED
```

The Redis key `containerState:{id}` is the fast path that the proxy checks without hitting the DB:
- `running` → proxy normally
- `sleeping` → serve wake page
- `starting` → serve wake page (already waking)
- absent → treat as sleeping (safe default)

---

### Phase G: Horizontal Scaling for Build Workers (Week 6)

Your current setup has one ECS task per build. This is already horizontally scaled at the task level. But to control costs and concurrency, add explicit limits:

**Concurrency control via BullMQ:**

```javascript
// In the worker config:
const worker = new Worker('builds', processBuild, {
    connection,
    concurrency: 3,  // max 3 simultaneous ECS builds at a time
    limiter: {
        max: 10,       // max 10 jobs per
        duration: 60_000  // 60 seconds
    }
})
```

**Cost estimation table to include in your project README:**

| Scenario | ECS Fargate vCPU | Estimated Cost |
|---|---|---|
| 1 build, ~3 min | 1 vCPU, 2GB RAM | ~$0.002 |
| 10 concurrent builds | 10 vCPU | ~$0.02 |
| Dynamic app running 24/7 | 0.25 vCPU, 512MB | ~$8/month |
| Same app with scale-to-zero (50% active) | 0.25 vCPU | ~$4/month |

With scale-to-zero on dynamic apps and concurrency limits on builds, your bill stays predictable.

---

## Part 3: Complete Priority Matrix

### P0 — Do These Before Showing Anyone (Week 1)

1. Move all credentials to `.env` — right now the codebase has empty string credentials
2. Fix the preview URL to use a real domain
3. Add PostgreSQL + Prisma with the deployment schema above
4. Add status publishing from build-server (building/running/failed)
5. Switch `ubuntu:focal` to `node:20-alpine` in the build Dockerfile

### P1 — Core Product Completeness (Week 2-3)

6. Add JWT auth (register, login, me)
7. Add BullMQ queue between API and ECS dispatch
8. Add framework detection (static vs dynamic split)
9. Replace Socket.io with SSE for log streaming (simpler, no extra port)
10. Build a proper Next.js dashboard (project list, deployment history, status page)

### P2 — Impressive Engineering (Week 4-5)

11. Dynamic app path: ECR image build → ECS Service with ALB listener rules
12. Scale-to-zero: idle detector + wake proxy + wake worker
13. Add Bull Board at `/admin/queues`
14. Per-project environment variable storage (AES-256 encrypted at rest)
15. Deployment state machine with proper transitions

### P3 — Resume Differentiators (Week 6+)

16. GitHub OAuth + webhook auto-deploy
17. Branch-based preview deployments
18. Rollback to any previous deployment
19. Prometheus metrics + Grafana dashboard
20. Custom domain support via Cloudflare API

---

## Part 4: The ExecutionEngine Abstraction

As your `multi_engine.md` doc describes, wrap both execution paths behind a single interface. This keeps your BullMQ worker completely environment-agnostic and makes the codebase far easier to reason about:

```typescript
// engine.interface.ts
interface ExecutionEngine {
    buildStatic(job: BuildJob): Promise<StaticBuildResult>
    buildDynamic(job: BuildJob): Promise<DynamicBuildResult>
    sleepDeployment(deploymentId: string): Promise<void>
    wakeDeployment(deploymentId: string): Promise<void>
    stopDeployment(deploymentId: string): Promise<void>
    getDeploymentStatus(deploymentId: string): Promise<DeploymentStatus>
}

// cloud.engine.ts
class CloudEngine implements ExecutionEngine {
    async buildStatic(job) {
        // ECS RunTask → npm build → S3 sync
    }
    async buildDynamic(job) {
        // ECS RunTask for build → docker build → ECR push → ECS CreateService
    }
    async sleepDeployment(id) {
        // ECS UpdateService desiredCount: 0
    }
    async wakeDeployment(id) {
        // ECS UpdateService desiredCount: 1 + wait for stable
    }
}

// bare-metal.engine.ts  (for local dev)
class BareMetalEngine implements ExecutionEngine {
    async buildStatic(job) {
        // git clone → npm build → serve /dist via nginx
    }
    async buildDynamic(job) {
        // docker run on local daemon → nginx upstream
    }
    async sleepDeployment(id) {
        // docker pause (instant, no cold start penalty)
    }
    async wakeDeployment(id) {
        // docker unpause (~100ms vs Fargate's 15-30s)
    }
}

// factory
const engine: ExecutionEngine = process.env.DEPLOYMENT_ENVIRONMENT === 'cloud'
    ? new CloudEngine()
    : new BareMetalEngine()

export default engine
```

The `docker pause` / `docker unpause` difference on bare metal is worth highlighting — it freezes the container in place without deallocating memory, so the "cold start" is 100ms instead of 15-30s. This is a great talking point in interviews about tradeoffs between cloud and self-hosted infrastructure.

---

## Part 5: What to Say in Interviews

The current codebase is a good starting point but not yet impressive. Once you complete through P2, here's the narrative:

**On the scale-to-zero design:** "I built an idle detection system that scans running deployments every 60 seconds using a Redis MGET across all active deployment keys — it's O(n) but extremely cheap since it's just in-memory reads. When a deployment goes idle, a BullMQ job scales the ECS service to 0. The interesting engineering problem was the wake-up: if you naively drop the first request after sleep, users see a connection error. So I built a wake-up proxy that detects the sleeping state via a Redis key, serves a browser loading page with 3-second polling for HTML clients and 503 + Retry-After for API clients, and uses a Redis SET NX to ensure only one wake job fires even if 100 requests arrive simultaneously."

**On the static vs dynamic split:** "Static builds — React, Vite, plain HTML — are ephemeral: an ECS task clones the repo, builds, syncs to S3, and exits. The reverse proxy streams directly from S3, so there's no running container to manage. Dynamic apps — Next.js SSR, Express — need a persistent container, so I push a Docker image to ECR and create an ECS Service with an ALB listener rule per deployment. The subdomain routes to a per-deployment target group. The framework detector runs inside the build container, so the decision is made at build time, not configuration time."

**On cost efficiency:** "With scale-to-zero on dynamic apps, a deployment that gets traffic 8 hours a day costs roughly half what it would running 24/7 on Fargate. With BullMQ concurrency limiting at 3 simultaneous builds, I cap the maximum burst ECS cost regardless of how many deploys are triggered simultaneously."
