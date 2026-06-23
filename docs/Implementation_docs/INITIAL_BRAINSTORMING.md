# Dreamer — Production Database & Dashboard Deep Dive

---

## Part 1: Database Architecture

### Technology Choices and Why

**PostgreSQL** via Neon (serverless) or a managed RDS instance. Not SQLite, not MongoDB. Reasons that matter for this project specifically:

- Row-level locking for deployment state transitions — you cannot let two BullMQ worker retries simultaneously set a deployment to `building`
- `ENUM` types enforce state machine transitions at the DB layer, not just application layer
- `FOR UPDATE SKIP LOCKED` is how BullMQ itself works; your manual advisory locks will use the same pattern
- `JSONB` for flexible metadata columns (build stats, ECS task metadata) without schema migrations on every feature
- Full-text search on deployment logs via `tsvector` — lets you build "search my build logs" later
- `TIMESTAMPTZ` everywhere (not `TIMESTAMP`) — all times in UTC, displayed in user's local timezone on the frontend

**Prisma as the ORM.** Not raw pg, not Drizzle. Prisma gives you:
- Type-safe queries that match the schema exactly
- `prisma migrate dev` creates SQL migration files you can version-control and review
- `prisma generate` regenerates the TS client after schema changes
- Schema-as-source-of-truth: the `.prisma` file is your single definition of the data model

**Connection pooling via PgBouncer or Prisma Accelerate.** Your API server will have multiple Express workers (or Lambda/ECS replicas) all opening DB connections. Without a pooler, you'll hit PostgreSQL's connection limit (~100 default). Neon has a built-in pooler — use `?pgbouncer=true` in the connection string.

---

### The Full Production Schema

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─────────────────────────────────────────────
// ENUMS — enforced at DB level
// ─────────────────────────────────────────────

enum DeploymentStatus {
  QUEUED      // Job created in BullMQ, DB record exists, ECS not yet launched
  BUILDING    // ECS task is running: git clone + npm install + npm build
  UPLOADING   // (Static only) Syncing dist/ to S3
  STARTING    // (Dynamic only) ECS service created, container starting, health check pending
  RUNNING     // App is live and responding
  SLEEPING    // (Dynamic only) ECS service scaled to desiredCount=0
  WAKING      // (Dynamic only) ECS service scaling back up, wake proxy is holding requests
  STOPPED     // Manually stopped by user or replaced by newer deployment
  FAILED      // Any step errored — see errorMessage + errorCode
  CANCELLED   // Queued but cancelled before a worker picked it up
}

enum DeploymentType {
  STATIC   // React, Vite, Vue, Next export, plain HTML → S3
  DYNAMIC  // Next.js SSR, Express, Fastify, Hono → persistent ECS container
}

enum Framework {
  REACT_CRA
  REACT_VITE
  VUE
  SVELTE
  NEXT_STATIC   // next.config output: 'export'
  NEXT_SSR      // standard Next.js
  EXPRESS
  FASTIFY
  HONO
  STATIC_HTML
  UNKNOWN
}

enum LogLevel {
  INFO
  WARN
  ERROR
  DEBUG
  SYSTEM  // Internal platform messages (e.g. "Uploading to S3", "Container starting")
}

enum WebhookEvent {
  PUSH
  PULL_REQUEST
  RELEASE
}

// ─────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────

model User {
  id               String    @id @default(uuid()) @db.Uuid
  email            String    @unique @db.VarChar(320)
  passwordHash     String    @db.VarChar(255)    // bcrypt, cost factor 12
  name             String?   @db.VarChar(255)
  avatarUrl        String?

  // GitHub OAuth (nullable — user may log in with email/password)
  githubId         Int?      @unique
  githubUsername   String?   @db.VarChar(255)
  githubToken      String?   // AES-256-GCM encrypted — see encryption note below

  // Refresh token for JWT rotation
  refreshTokenHash String?   // bcrypt hash of the current refresh token

  // Soft account management
  emailVerified    Boolean   @default(false)
  isActive         Boolean   @default(true)  // false = suspended
  
  createdAt        DateTime  @default(now()) @db.Timestamptz
  updatedAt        DateTime  @updatedAt @db.Timestamptz
  lastLoginAt      DateTime? @db.Timestamptz

  // Relations
  projects         Project[]
  sessions         UserSession[]
  auditLogs        AuditLog[]

  @@index([email])
  @@index([githubId])
}

// ─────────────────────────────────────────────
// USER SESSIONS
// Tracks active refresh tokens. Lets you invalidate 
// all sessions on password change or from a "Sign out everywhere" button.
// ─────────────────────────────────────────────

model UserSession {
  id            String    @id @default(uuid()) @db.Uuid
  userId        String    @db.Uuid
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  tokenHash     String    @unique   // bcrypt hash of the refresh token — never store the raw token
  userAgent     String?   @db.VarChar(512)
  ipAddress     String?   @db.VarChar(45)   // supports IPv6
  
  expiresAt     DateTime  @db.Timestamptz
  createdAt     DateTime  @default(now()) @db.Timestamptz
  lastUsedAt    DateTime  @default(now()) @db.Timestamptz

  @@index([userId])
  @@index([expiresAt])  // for cleanup jobs that delete expired sessions
}

// ─────────────────────────────────────────────
// PROJECTS
// A project = one GitHub repo + all its deployments
// ─────────────────────────────────────────────

model Project {
  id               String    @id @default(uuid()) @db.Uuid
  userId           String    @db.Uuid
  user             User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  name             String    @db.VarChar(255)
  slug             String    @unique @db.VarChar(63)  // used in URLs, max 63 chars (DNS label limit)
  description      String?   @db.VarChar(500)

  // Source repo
  repoUrl          String    @db.VarChar(2048)
  repoFullName     String?   @db.VarChar(512)   // "owner/repo" for GitHub API calls
  defaultBranch    String    @default("main") @db.VarChar(255)
  isPrivate        Boolean   @default(false)

  // GitHub webhook (set when user connects GitHub)
  webhookId        Int?      // GitHub's webhook ID — needed to delete webhook on disconnect
  webhookSecret    String?   // HMAC secret for validating push events (AES-256 encrypted)

  // Computed / cached fields (denormalized for dashboard query performance)
  activeDeploymentId  String?  @db.Uuid   // FK set after a deployment reaches RUNNING
  lastDeployedAt      DateTime? @db.Timestamptz

  // Soft delete
  deletedAt        DateTime? @db.Timestamptz

  createdAt        DateTime  @default(now()) @db.Timestamptz
  updatedAt        DateTime  @updatedAt @db.Timestamptz

  // Relations
  deployments      Deployment[]
  envVariables     EnvVariable[]
  customDomains    CustomDomain[]
  webhookDeliveries WebhookDelivery[]

  @@index([userId, deletedAt])      // "my projects" query — filters out deleted
  @@index([slug])
  @@index([repoFullName])           // webhook handler lookup: "which project owns this repo?"
}

// ─────────────────────────────────────────────
// DEPLOYMENTS
// One row per deploy attempt.
// ─────────────────────────────────────────────

model Deployment {
  id               String            @id @default(uuid()) @db.Uuid
  projectId        String            @db.Uuid
  project          Project           @relation(fields: [projectId], references: [id], onDelete: Cascade)

  // Unique public identifier — becomes the subdomain
  // e.g. "fuzzy-cat-42" → fuzzy-cat-42.dreamer.yourdomain.com
  slug             String            @unique @db.VarChar(63)
  
  status           DeploymentStatus  @default(QUEUED)
  type             DeploymentType?   // set after framework detection
  framework        Framework?        // set after framework detection

  // Source
  branch           String            @default("main") @db.VarChar(255)
  commitHash       String?           @db.VarChar(40)   // full SHA
  commitMessage    String?           @db.VarChar(500)
  commitAuthor     String?           @db.VarChar(255)

  // Output
  url              String?           // public URL once RUNNING
  
  // AWS resource references (needed for stop/sleep/wake/scale operations)
  ecsTaskArn       String?           // for STATIC builds (RunTask — ephemeral)
  ecsServiceArn    String?           // for DYNAMIC apps (CreateService — persistent)
  ecsTaskDefArn    String?           // the registered task definition ARN
  ecrImageUri      String?           // ECR image URI for dynamic apps
  albTargetGroupArn String?          // per-deployment ALB target group
  albListenerRuleArn String?         // per-deployment ALB listener rule
  s3Prefix         String?           // for static: "__outputs/{slug}/"

  // Error tracking
  errorMessage     String?           @db.Text
  errorCode        String?           @db.VarChar(50)   // machine-readable: BUILD_FAILED | S3_UPLOAD_FAILED | ECS_TIMEOUT etc.
  errorStep        String?           @db.VarChar(50)   // which step failed: install | build | upload | start

  // Build metrics
  buildDurationMs  Int?              // total build time in ms
  uploadedFileCount Int?             // how many files uploaded to S3 (static only)
  imageSizeBytes   Int?              // Docker image size (dynamic only)

  // Scale-to-zero tracking
  lastRequestAt    DateTime?         @db.Timestamptz   // kept in Redis too, synced here for durability
  sleepCount       Int               @default(0)        // how many times this deployment has slept
  totalSleepMs     BigInt            @default(0)        // total accumulated sleep time

  // Trigger info
  triggeredBy      String            @default("manual") // "manual" | "webhook" | "api"
  webhookDeliveryId String?          @db.Uuid

  // Timestamps for each state transition
  queuedAt         DateTime          @default(now()) @db.Timestamptz
  buildStartedAt   DateTime?         @db.Timestamptz
  buildFinishedAt  DateTime?         @db.Timestamptz
  deployedAt       DateTime?         @db.Timestamptz   // when it first reached RUNNING
  stoppedAt        DateTime?         @db.Timestamptz

  createdAt        DateTime          @default(now()) @db.Timestamptz
  updatedAt        DateTime          @updatedAt @db.Timestamptz

  // Relations
  logs             DeploymentLog[]
  stateTransitions DeploymentStateTransition[]
  envSnapshot      DeploymentEnvSnapshot[]

  @@index([projectId, createdAt(sort: Desc)])   // "deployments for this project" query
  @@index([status])                              // idle detector: WHERE status = 'RUNNING' AND type = 'DYNAMIC'
  @@index([slug])
  @@index([ecsServiceArn])                       // reverse lookup for ECS event bridge events
}

// ─────────────────────────────────────────────
// DEPLOYMENT STATE TRANSITIONS
// Append-only audit trail of every status change.
// Critical for debugging "why did this deployment fail"
// and for building a timeline view in the dashboard.
// ─────────────────────────────────────────────

model DeploymentStateTransition {
  id             String            @id @default(uuid()) @db.Uuid
  deploymentId   String            @db.Uuid
  deployment     Deployment        @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  
  fromStatus     DeploymentStatus?  // null for the first transition (QUEUED)
  toStatus       DeploymentStatus
  reason         String?            @db.VarChar(500)  // human-readable: "Build completed", "ECS health check timeout"
  triggeredBy    String?            @db.VarChar(100)  // "build-worker" | "idle-detector" | "user-api" | "ecs-event"
  metadata       Json?              // e.g. { "taskExitCode": 1, "workerJobId": "..." }
  
  createdAt      DateTime           @default(now()) @db.Timestamptz

  @@index([deploymentId, createdAt])
}

// ─────────────────────────────────────────────
// DEPLOYMENT LOGS
// Every line of output from git clone, npm install, npm build,
// S3 upload, container start — all stored here.
// This is the highest-volume table. 
// ─────────────────────────────────────────────

model DeploymentLog {
  id             BigInt     @id @default(autoincrement())   // BigInt — this table will have millions of rows
  deploymentId   String     @db.Uuid
  deployment     Deployment @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  
  level          LogLevel   @default(INFO)
  message        String     @db.Text
  
  // Full-text search index (built in migration, not in Prisma schema)
  // See migration note below.
  
  sequence       Int        // monotonically increasing within a deployment (for ordered SSE replay)
  source         String?    @db.VarChar(50)   // "build" | "npm" | "s3" | "platform" | "container"
  
  timestamp      DateTime   @default(now()) @db.Timestamptz

  @@index([deploymentId, sequence])     // log stream query: ORDER BY sequence
  @@index([deploymentId, timestamp])    // time-range queries
  // Full-text index created in raw migration — see migration note
}

// ─────────────────────────────────────────────
// ENV VARIABLES
// Per-project secrets. Values are AES-256-GCM encrypted in the application layer
// before being stored. The DB never sees plaintext secrets.
// ─────────────────────────────────────────────

model EnvVariable {
  id           String   @id @default(uuid()) @db.Uuid
  projectId    String   @db.Uuid
  project      Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  
  key          String   @db.VarChar(255)
  value        String   @db.Text        // AES-256-GCM encrypted blob (base64)
  iv           String   @db.VarChar(32) // Initialization vector for AES-GCM (per value)
  
  isSecret     Boolean  @default(true)   // false = shown in UI, true = masked
  description  String?  @db.VarChar(500)
  
  createdAt    DateTime @default(now()) @db.Timestamptz
  updatedAt    DateTime @updatedAt @db.Timestamptz

  @@unique([projectId, key])   // one value per key per project
  @@index([projectId])
}

// ─────────────────────────────────────────────
// DEPLOYMENT ENV SNAPSHOT
// At deploy time, copy the resolved env vars into the deployment record.
// This means: if you change an env var after deploying, old deployments
// still have a record of what they were built with. Critical for rollbacks.
// ─────────────────────────────────────────────

model DeploymentEnvSnapshot {
  id             String     @id @default(uuid()) @db.Uuid
  deploymentId   String     @db.Uuid
  deployment     Deployment @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  
  key            String     @db.VarChar(255)
  value          String     @db.Text        // Still encrypted — decrypted only when injecting into ECS task
  iv             String     @db.VarChar(32)
  
  @@index([deploymentId])
}

// ─────────────────────────────────────────────
// CUSTOM DOMAINS
// Users can attach their own domain to a project's active deployment.
// ─────────────────────────────────────────────

model CustomDomain {
  id              String   @id @default(uuid()) @db.Uuid
  projectId       String   @db.Uuid
  project         Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  
  domain          String   @unique @db.VarChar(253)  // e.g. "myapp.com"
  
  // Verification
  verificationToken String  @db.VarChar(64)  // TXT record value user must add to their DNS
  verified          Boolean @default(false)
  verifiedAt        DateTime? @db.Timestamptz
  
  // SSL
  sslStatus         String    @default("pending")  // pending|issuing|active|error
  sslIssuedAt       DateTime? @db.Timestamptz
  sslExpiresAt      DateTime? @db.Timestamptz
  
  createdAt         DateTime  @default(now()) @db.Timestamptz
  updatedAt         DateTime  @updatedAt @db.Timestamptz

  @@index([projectId])
  @@index([domain])
}

// ─────────────────────────────────────────────
// WEBHOOK DELIVERIES
// Every GitHub webhook push event, logged.
// Required for debugging "why didn't my push trigger a deploy"
// ─────────────────────────────────────────────

model WebhookDelivery {
  id              String   @id @default(uuid()) @db.Uuid
  projectId       String   @db.Uuid
  project         Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  
  githubDeliveryId String? @db.VarChar(255)   // X-GitHub-Delivery header
  event           WebhookEvent
  branch          String   @db.VarChar(255)
  commitHash      String?  @db.VarChar(40)
  commitMessage   String?  @db.VarChar(500)
  
  // Was a deployment triggered?
  deploymentTriggered Boolean  @default(false)
  deploymentId        String?  @db.Uuid
  skipReason          String?  @db.VarChar(255)  // e.g. "branch not watched" | "already building"
  
  rawPayload      Json?    // store the full GitHub payload for debugging
  
  receivedAt      DateTime @default(now()) @db.Timestamptz

  @@index([projectId, receivedAt(sort: Desc)])
}

// ─────────────────────────────────────────────
// AUDIT LOG
// Every sensitive action a user takes.
// Required for "who deleted my project" questions.
// ─────────────────────────────────────────────

model AuditLog {
  id           BigInt   @id @default(autoincrement())
  userId       String?  @db.Uuid   // null for unauthenticated actions
  user         User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  
  action       String   @db.VarChar(100)    // "project.create" | "deployment.stop" | "env.update" | "user.login"
  resourceType String?  @db.VarChar(50)     // "project" | "deployment" | "env_variable"
  resourceId   String?  @db.VarChar(36)
  
  ipAddress    String?  @db.VarChar(45)
  userAgent    String?  @db.VarChar(512)
  
  metadata     Json?    // action-specific data
  
  createdAt    DateTime @default(now()) @db.Timestamptz

  @@index([userId, createdAt(sort: Desc)])
  @@index([resourceType, resourceId])
  @@index([createdAt])  // for retention cleanup job
}
```

---

### Raw SQL Migrations for Things Prisma Can't Express

Prisma doesn't support all PostgreSQL features. These go in your migration files under `prisma/migrations/`:

**Full-text search on deployment logs:**

```sql
-- prisma/migrations/20240101_add_log_fts/migration.sql

-- Add tsvector column for full-text search
ALTER TABLE "DeploymentLog" ADD COLUMN ts_message tsvector
  GENERATED ALWAYS AS (to_tsvector('english', message)) STORED;

CREATE INDEX idx_deployment_log_fts 
  ON "DeploymentLog" USING GIN (ts_message);
```

This makes queries like "find all logs containing 'MODULE_NOT_FOUND'" fast across millions of rows.

**Deployment sequence counter (for log ordering):**

```sql
-- Atomic sequence per deployment — ensures log lines are always ordered correctly
-- even when multiple publish calls happen in the same millisecond

CREATE SEQUENCE deployment_log_seq START 1;

-- Function to get-and-increment per deployment
CREATE OR REPLACE FUNCTION next_log_sequence(dep_id UUID) RETURNS INT AS $$
  SELECT nextval('deployment_log_seq_' || replace(dep_id::text, '-', '_'));
$$ LANGUAGE SQL;
```

In practice, simpler: just use `SELECT COALESCE(MAX(sequence), 0) + 1 FROM "DeploymentLog" WHERE "deploymentId" = $1` inside a transaction. The sequence column guarantees frontend SSE can replay in correct order.

**Enforce state machine at DB level:**

```sql
-- Only allow valid status transitions
-- Prevents application bugs from corrupting deployment state

CREATE OR REPLACE FUNCTION check_deployment_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Define valid transitions
  IF (OLD.status = 'QUEUED' AND NEW.status NOT IN ('BUILDING', 'CANCELLED', 'FAILED')) OR
     (OLD.status = 'BUILDING' AND NEW.status NOT IN ('UPLOADING', 'STARTING', 'RUNNING', 'FAILED')) OR
     (OLD.status = 'UPLOADING' AND NEW.status NOT IN ('RUNNING', 'FAILED')) OR
     (OLD.status = 'STARTING' AND NEW.status NOT IN ('RUNNING', 'FAILED')) OR
     (OLD.status = 'RUNNING' AND NEW.status NOT IN ('SLEEPING', 'STOPPED', 'FAILED')) OR
     (OLD.status = 'SLEEPING' AND NEW.status NOT IN ('WAKING', 'STOPPED')) OR
     (OLD.status = 'WAKING' AND NEW.status NOT IN ('RUNNING', 'FAILED', 'STOPPED')) OR
     (OLD.status IN ('STOPPED', 'FAILED', 'CANCELLED') AND OLD.status != NEW.status)
  THEN
    RAISE EXCEPTION 'Invalid deployment status transition from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_deployment_status_transition
  BEFORE UPDATE OF status ON "Deployment"
  FOR EACH ROW EXECUTE FUNCTION check_deployment_status_transition();
```

This is the DB layer catching what application code should never allow but sometimes does under race conditions.

**Composite partial index for the idle detector:**

```sql
-- The idle detection job runs: 
-- SELECT * FROM "Deployment" WHERE status = 'RUNNING' AND type = 'DYNAMIC'
-- This partial index covers exactly that query at O(active_dynamic_deployments) not O(all_deployments)

CREATE INDEX idx_deployment_active_dynamic
  ON "Deployment" (status, "lastRequestAt")
  WHERE status = 'RUNNING' AND type = 'DYNAMIC';
```

---

### Application-Layer Encryption for Secrets

The `EnvVariable.value` column stores encrypted blobs. Here's the exact implementation:

```typescript
// src/lib/crypto.ts
import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex')  // 64 hex chars = 32 bytes

if (KEY.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
}

export function encrypt(plaintext: string): { encrypted: string; iv: string } {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv)
  
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ])
  const authTag = cipher.getAuthTag()
  
  // Store: encrypted + authTag as one blob
  const blob = Buffer.concat([encrypted, authTag])
  
  return {
    encrypted: blob.toString('base64'),
    iv: iv.toString('hex')
  }
}

export function decrypt(encrypted: string, iv: string): string {
  const ivBuffer = Buffer.from(iv, 'hex')
  const blob = Buffer.from(encrypted, 'base64')
  
  // Last 16 bytes are the auth tag
  const authTag = blob.slice(blob.length - 16)
  const encryptedData = blob.slice(0, blob.length - 16)
  
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, ivBuffer)
  decipher.setAuthTag(authTag)
  
  return Buffer.concat([
    decipher.update(encryptedData),
    decipher.final()
  ]).toString('utf8')
}
```

Generate the key once: `node -e "console.log(crypto.randomBytes(32).toString('hex'))"` — store it in AWS Secrets Manager or at minimum as an environment variable that is never committed to git.

---

### State Transition Service (Application Layer)

Never call `prisma.deployment.update({ data: { status: '...' } })` directly across your codebase. Centralize all state transitions through one function that atomically updates the deployment, inserts a state transition audit record, publishes to Redis, and checks the valid transition:

```typescript
// src/services/deployment-state.service.ts
import { prisma } from '../db/client'
import { redis } from '../lib/redis'
import { DeploymentStatus } from '@prisma/client'

interface TransitionOptions {
  reason?: string
  triggeredBy?: string
  metadata?: Record<string, unknown>
  additionalData?: Partial<{
    errorMessage: string
    errorCode: string
    errorStep: string
    buildDurationMs: number
    url: string
    ecsServiceArn: string
    ecsTaskArn: string
    buildStartedAt: Date
    buildFinishedAt: Date
    deployedAt: Date
    stoppedAt: Date
    framework: string
    type: string
  }>
}

export async function transitionDeployment(
  deploymentId: string,
  toStatus: DeploymentStatus,
  options: TransitionOptions = {}
) {
  const { reason, triggeredBy, metadata, additionalData } = options

  // Use a transaction so the state update + audit record are atomic
  const [deployment] = await prisma.$transaction([
    prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: toStatus,
        ...additionalData,
        // Automatically set transition timestamps
        ...(toStatus === 'BUILDING' && { buildStartedAt: new Date() }),
        ...(toStatus === 'RUNNING' && { deployedAt: new Date() }),
        ...(toStatus === 'STOPPED' && { stoppedAt: new Date() }),
        ...(toStatus === 'FAILED' && { stoppedAt: new Date() }),
      },
    }),
    prisma.deploymentStateTransition.create({
      data: {
        deploymentId,
        toStatus,
        reason,
        triggeredBy,
        metadata: metadata as any,
      },
    }),
  ])

  // Publish status event to Redis → API server → SSE → frontend
  // The frontend uses this to update the status badge in real time
  await redis.publish(
    `status:${deploymentId}`,
    JSON.stringify({
      status: toStatus,
      url: deployment.url,
      errorMessage: deployment.errorMessage,
      timestamp: new Date().toISOString(),
    })
  )

  return deployment
}
```

Every part of the system — the build worker, the idle detector, the wake worker, the user-facing stop API — calls `transitionDeployment()` and nothing else.

---

### Database Connection Setup

```typescript
// src/db/client.ts
import { PrismaClient } from '@prisma/client'

// Prisma recommends a singleton pattern in Node.js
// to avoid exhausting the connection pool in dev hot-reloads
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'warn', 'error']
      : ['warn', 'error'],
    errorFormat: 'minimal',
  })

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma
}

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect()
})
```

```typescript
// src/db/health.ts
// Used in your health check endpoint: GET /health
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}
```

---

### Key Queries — Optimised

**Dashboard project list** (most complex, runs on every dashboard load):

```typescript
// Fetch all projects for a user with their latest deployment status
// Single query — no N+1
export async function getUserProjectsWithLatestDeployment(userId: string) {
  return prisma.project.findMany({
    where: {
      userId,
      deletedAt: null,
    },
    include: {
      deployments: {
        orderBy: { createdAt: 'desc' },
        take: 1,  // only the most recent deployment
        select: {
          id: true,
          status: true,
          url: true,
          framework: true,
          type: true,
          deployedAt: true,
          buildDurationMs: true,
          branch: true,
          commitHash: true,
          commitMessage: true,
        },
      },
      _count: {
        select: { deployments: true }
      },
    },
    orderBy: { lastDeployedAt: 'desc' },
  })
}
```

**Live log stream** (SSE endpoint, polled every 500ms):

```typescript
// Returns logs after a given sequence number
// The client tracks the last sequence it received and sends it as a cursor
export async function getLogsAfterSequence(
  deploymentId: string,
  afterSequence: number,
  limit = 100
) {
  return prisma.deploymentLog.findMany({
    where: {
      deploymentId,
      sequence: { gt: afterSequence },
    },
    orderBy: { sequence: 'asc' },
    take: limit,
    select: {
      sequence: true,
      level: true,
      message: true,
      source: true,
      timestamp: true,
    },
  })
}
```

**Deployment history for a project** (paginated):

```typescript
export async function getDeploymentHistory(
  projectId: string,
  cursor?: string,
  limit = 20
) {
  return prisma.deployment.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor && { skip: 1, cursor: { id: cursor } }),
    select: {
      id: true,
      slug: true,
      status: true,
      type: true,
      framework: true,
      url: true,
      branch: true,
      commitHash: true,
      commitMessage: true,
      commitAuthor: true,
      buildDurationMs: true,
      triggeredBy: true,
      queuedAt: true,
      buildStartedAt: true,
      deployedAt: true,
      stoppedAt: true,
      errorMessage: true,
      errorCode: true,
    },
  })
}
```

**Idle detector query** (runs every 60s):

```typescript
export async function getIdleDynamicDeployments(thresholdMs: number) {
  const cutoff = new Date(Date.now() - thresholdMs)
  
  return prisma.deployment.findMany({
    where: {
      status: 'RUNNING',
      type: 'DYNAMIC',
      OR: [
        { lastRequestAt: { lt: cutoff } },
        { lastRequestAt: null, deployedAt: { lt: cutoff } }  // never received a request
      ],
    },
    select: {
      id: true,
      slug: true,
      ecsServiceArn: true,
      project: { select: { userId: true, name: true } },
    },
  })
}
```

---

### Data Retention Strategy

The `DeploymentLog` table will grow fast. A build with verbose npm output easily generates 500–1000 log rows. At 100 deployments/day that's 50,000–100,000 rows/day. Add a nightly cleanup job:

```typescript
// src/jobs/log-retention.job.ts
// Keep logs for 30 days for active projects, 7 days for stopped/failed deployments
export async function runLogRetention() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  // Delete logs for old terminal-state deployments
  await prisma.deploymentLog.deleteMany({
    where: {
      deployment: {
        status: { in: ['STOPPED', 'FAILED', 'CANCELLED'] },
        stoppedAt: { lt: sevenDaysAgo },
      },
    },
  })

  // Delete logs older than 30 days for any deployment
  await prisma.deploymentLog.deleteMany({
    where: {
      timestamp: { lt: thirtyDaysAgo },
    },
  })
  
  // Delete expired sessions
  await prisma.userSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
  
  // Delete audit logs older than 90 days
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: ninetyDaysAgo } },
  })
}
```

Register it as a BullMQ repeatable job alongside your idle detector.

---

## Part 2: Dashboard Architecture

### Route Structure

```
app/
├── (auth)/
│   ├── login/
│   │   └── page.tsx           # Email/password + "Continue with GitHub"
│   └── register/
│       └── page.tsx           # Sign up form
│
├── (dashboard)/
│   ├── layout.tsx             # Sidebar + topbar shell, auth guard
│   │
│   ├── page.tsx               # Dashboard home: project cards grid
│   │
│   ├── projects/
│   │   ├── new/
│   │   │   └── page.tsx       # Create project form
│   │   │
│   │   └── [projectId]/
│   │       ├── page.tsx       # Project overview: active deployment + recent deploys
│   │       ├── deployments/
│   │       │   ├── page.tsx                   # Full deployment history table
│   │       │   └── [deploymentId]/
│   │       │       └── page.tsx               # Deployment detail: logs, status timeline, metrics
│   │       ├── settings/
│   │       │   ├── page.tsx                   # General: name, repo URL, branch
│   │       │   ├── env/
│   │       │   │   └── page.tsx               # Environment variables CRUD
│   │       │   ├── domains/
│   │       │   │   └── page.tsx               # Custom domains
│   │       │   └── danger/
│   │       │       └── page.tsx               # Delete project
│   │       └── webhooks/
│   │           └── page.tsx                   # Webhook delivery log
│   │
│   └── settings/
│       ├── page.tsx           # Account settings: name, email, avatar
│       ├── security/
│       │   └── page.tsx       # Password change, active sessions list, revoke
│       └── github/
│           └── page.tsx       # Connect/disconnect GitHub OAuth
│
└── api/
    ├── auth/
    │   ├── [...nextauth]/     # if using NextAuth, or your own:
    │   ├── register/route.ts
    │   ├── login/route.ts
    │   ├── refresh/route.ts
    │   └── logout/route.ts
    └── proxy/
        └── [...path]/route.ts # Optional: forward to Express API server
```

---

### Page-by-Page Specification

#### `/` — Dashboard Home

The single most important page. Recruiters will land here. Every project card must show:

- Project name + slug
- Live URL with an external link icon (opens the deployed app)
- Status badge (RUNNING/SLEEPING/FAILED/BUILDING) with appropriate color and pulse animation for active states
- Framework icon (React logo, Next.js logo, Vue logo, etc.)
- Last deployed time (relative: "3 hours ago") with absolute on hover
- Deployment count badge
- Quick-action: "Deploy" button that triggers a new deployment without leaving this page

Empty state (no projects yet): not a blank page. Show a "Deploy your first project" card with a GitHub URL input directly in the card — same as your current single-page UI, but integrated into the dashboard shell.

**Data fetching:**

```typescript
// app/(dashboard)/page.tsx
import { getUserProjectsWithLatestDeployment } from '@/db/queries/projects'
import { getCurrentUser } from '@/lib/auth'

export default async function DashboardPage() {
  const user = await getCurrentUser()
  const projects = await getUserProjectsWithLatestDeployment(user.id)
  
  return <ProjectGrid projects={projects} />
}
```

This is a React Server Component — the data fetch happens on the server, no loading spinner, no client-side fetch needed. Use `loading.tsx` for the Suspense skeleton.

---

#### `/projects/[projectId]` — Project Overview

Two-column layout:

**Left column (2/3 width):**
- Active deployment panel: big status badge, live URL, "Visit" button, "Rollback" button, framework badge, build time
- Recent deployment list: last 5 deployments as rows (commit hash, status, time ago, build duration, link to detail page)
- "Deploy from branch" form: dropdown of branches from GitHub API + "Deploy" button

**Right column (1/3 width):**
- Repo info card: GitHub link, branch, last commit
- Activity feed: last 10 webhook deliveries (commit message + whether it triggered a deploy)
- Quick stats: total deployments, success rate, average build time

**The "Deploy" button flow:**

```typescript
// This is a Server Action in Next.js 14
'use server'
async function triggerDeployment(projectId: string, branch: string) {
  const user = await getCurrentUser()
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: user.id }
  })
  if (!project) throw new Error('Not found')
  
  const deployment = await prisma.deployment.create({
    data: {
      projectId,
      slug: generateSlug(),
      branch,
      triggeredBy: 'manual',
      status: 'QUEUED',
    }
  })
  
  await buildQueue.add('build', {
    deploymentId: deployment.id,
    projectId: project.id,
    repoUrl: project.repoUrl,
    slug: deployment.slug,
    branch,
  })
  
  // Redirect to the new deployment's log page
  redirect(`/projects/${projectId}/deployments/${deployment.id}`)
}
```

---

#### `/projects/[projectId]/deployments/[deploymentId]` — Deployment Detail

This is the most technically interesting page. Three sections:

**Section 1: Header bar**
- Deployment slug + status badge
- URL with copy button
- "Stop Deployment" button (if RUNNING or SLEEPING)
- "Rollback to this" button (if STOPPED/FAILED — requeues the same commit)
- Build time badge: "Built in 2m 34s"

**Section 2: Status Timeline**

A horizontal pipeline showing each state the deployment passed through, with timestamps. Pull from `DeploymentStateTransition`:

```
QUEUED (10:42:01) → BUILDING (10:42:04) → UPLOADING (10:44:18) → RUNNING (10:44:23)
   3s queue wait        2m 14s build             5s S3 upload          live
```

Render this as an SVG timeline or CSS flex row with connecting lines. Each node shows the state name, timestamp, and duration spent in that state. If a state is current (still active), show a pulsing dot.

**Section 3: Build Log Stream**

This is the real-time log panel. Implement it as a combination of:
- Initial load: fetch all existing logs from DB (server component, no flash)
- Real-time append: SSE connection for new logs while deployment is active
- Auto-scroll: scroll to bottom as new lines arrive, but stop auto-scrolling if user scrolls up
- Search: filter log lines with a search input (client-side filter on existing lines, no new query)
- Log level filter: buttons to show only ERROR, WARN, INFO

```typescript
// components/LogStream.tsx
'use client'
import { useEffect, useRef, useState } from 'react'

interface Log {
  sequence: number
  level: string
  message: string
  source: string
  timestamp: string
}

export function LogStream({ 
  deploymentId, 
  initialLogs, 
  isTerminal  // true if deployment is in STOPPED/FAILED/RUNNING state (no more new logs)
}: {
  deploymentId: string
  initialLogs: Log[]
  isTerminal: boolean
}) {
  const [logs, setLogs] = useState<Log[]>(initialLogs)
  const [autoScroll, setAutoScroll] = useState(true)
  const [filter, setFilter] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const lastSequence = useRef(initialLogs.at(-1)?.sequence ?? 0)

  // SSE connection — only open if deployment is still active
  useEffect(() => {
    if (isTerminal) return

    const es = new EventSource(`/api/deployments/${deploymentId}/logs/stream`)
    
    es.onmessage = (e) => {
      const newLog: Log = JSON.parse(e.data)
      setLogs(prev => [...prev, newLog])
      lastSequence.current = newLog.sequence
    }
    
    es.addEventListener('done', () => es.close())
    es.onerror = () => es.close()
    
    return () => es.close()
  }, [deploymentId, isTerminal])

  // Auto-scroll
  useEffect(() => {
    if (!autoScroll) return
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' })
  }, [logs, autoScroll])

  const filteredLogs = filter
    ? logs.filter(l => l.message.toLowerCase().includes(filter.toLowerCase()))
    : logs

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-2 border-b border-zinc-800">
        <input
          placeholder="Filter logs..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 bg-transparent text-sm outline-none"
        />
        <span className="text-xs text-zinc-500">{logs.length} lines</span>
      </div>
      
      {/* Log panel */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-sm"
        onScroll={(e) => {
          const el = e.currentTarget
          const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 20
          setAutoScroll(isAtBottom)
        }}
      >
        {filteredLogs.map(log => (
          <div
            key={log.sequence}
            className={`flex gap-3 py-0.5 ${
              log.level === 'ERROR' ? 'text-red-400' :
              log.level === 'WARN' ? 'text-yellow-400' :
              log.level === 'SYSTEM' ? 'text-blue-400' :
              'text-zinc-300'
            }`}
          >
            <span className="text-zinc-600 select-none w-16 shrink-0 text-right">
              {log.sequence}
            </span>
            <span className="text-zinc-600 select-none w-20 shrink-0">
              {new Date(log.timestamp).toLocaleTimeString()}
            </span>
            <span className="break-all">{log.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

#### `/projects/[projectId]/settings/env` — Environment Variables

This page handles sensitive data. Design principles:

- Values are never shown after saving — display masked as `••••••••` with a "Reveal" button that makes an authenticated API call (not stored in the page)
- "Reveal" is rate-limited to 10 reveals per hour per user (enforced in the API, logged in AuditLog)
- Bulk import: accept a `.env` file upload, parse it, preview the key-value pairs, confirm before saving
- "Redeploy required" warning banner if env vars have changed since the last deployment

```typescript
// The reveal endpoint — does not return the value in the initial page load
// POST /api/env-variables/[id]/reveal
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser()
  
  // Rate limit check
  const revealCount = await redis.incr(`reveal_count:${user.id}`)
  await redis.expire(`reveal_count:${user.id}`, 3600)
  if (revealCount > 10) {
    return Response.json({ error: 'Too many reveal requests' }, { status: 429 })
  }
  
  const envVar = await prisma.envVariable.findFirst({
    where: { id: params.id, project: { userId: user.id } }
  })
  if (!envVar) return Response.json({ error: 'Not found' }, { status: 404 })
  
  // Decrypt and return
  const plaintext = decrypt(envVar.value, envVar.iv)
  
  // Audit log
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'env.reveal',
      resourceType: 'env_variable',
      resourceId: envVar.id,
      ipAddress: req.headers.get('x-forwarded-for') ?? undefined,
    }
  })
  
  return Response.json({ value: plaintext })
}
```

---

#### `/settings/security` — Active Sessions

List all `UserSession` rows for the current user. Each row shows:
- Device (parsed from user agent: "Chrome on macOS", "Safari on iPhone")
- IP address + approximate location (use ip-api.com or similar)
- Last active time
- "Revoke" button — deletes the session row, invalidating that refresh token

This is a genuinely useful security feature and impressive to show: most junior projects don't think about session management at all.

---

### API Routes (Express Backend)

The complete set of routes grounding everything above:

```
AUTH
POST   /auth/register             Create account
POST   /auth/login                Return access + refresh tokens
POST   /auth/refresh              Rotate refresh token
POST   /auth/logout               Delete session record
GET    /auth/me                   Current user profile
GET    /auth/github               Redirect to GitHub OAuth
GET    /auth/github/callback      Handle GitHub OAuth callback

PROJECTS
GET    /projects                  List user projects + latest deployment
POST   /projects                  Create project
GET    /projects/:id              Project detail
PATCH  /projects/:id              Update name/branch/description
DELETE /projects/:id              Soft delete project + stop active deployment

DEPLOYMENTS
POST   /projects/:id/deploy       Trigger deployment → enqueue BullMQ job
GET    /projects/:id/deployments  Paginated deployment history
GET    /deployments/:id           Deployment detail + state transitions
POST   /deployments/:id/stop      Stop deployment (scale ECS to 0 or stop task)
POST   /deployments/:id/rollback  Requeue deployment with same commit + env snapshot
GET    /deployments/:id/logs      Paginated log history (for initial page load)
GET    /deployments/:id/logs/stream  SSE — streams new logs while build is active

ENV VARIABLES
GET    /projects/:id/env          List keys (values masked)
POST   /projects/:id/env          Create or upsert variable
PATCH  /env/:id                   Update key or value
DELETE /env/:id                   Delete variable
POST   /env/:id/reveal            Decrypt and return value (rate-limited, audited)

CUSTOM DOMAINS
GET    /projects/:id/domains      List custom domains
POST   /projects/:id/domains      Add custom domain + generate verification token
GET    /domains/:id/verify        Trigger DNS TXT check
DELETE /domains/:id               Remove domain

WEBHOOKS
POST   /webhooks/github           Receive GitHub push events (public, HMAC-verified)
GET    /projects/:id/webhooks     List webhook delivery history

ADMIN (authenticated + admin role check)
GET    /admin/stats               Platform-wide stats
GET    /admin/users               User list
```

---

### SSE Log Stream Implementation (Express)

```typescript
// src/routes/deployment-logs.route.ts
router.get('/:id/logs/stream', authMiddleware, async (req, res) => {
  const deployment = await prisma.deployment.findFirst({
    where: { id: req.params.id, project: { userId: req.user.id } }
  })
  if (!deployment) return res.status(404).end()

  // Terminal states: no new logs will arrive
  const terminalStatuses = ['RUNNING', 'STOPPED', 'FAILED', 'CANCELLED']
  if (terminalStatuses.includes(deployment.status)) {
    // Just serve the existing logs as a one-shot response, no streaming needed
    return res.json({ terminal: true })
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')  // Critical: prevents NGINX from buffering
  res.flushHeaders()

  let lastSequence = parseInt(req.query.after as string ?? '0')
  let done = false

  const sendLogs = async () => {
    if (done) return
    
    const newLogs = await getLogsAfterSequence(deployment.id, lastSequence)
    for (const log of newLogs) {
      res.write(`data: ${JSON.stringify(log)}\n\n`)
      lastSequence = log.sequence
    }

    // Check if deployment reached a terminal state
    const current = await prisma.deployment.findUnique({
      where: { id: deployment.id },
      select: { status: true }
    })
    
    if (current && terminalStatuses.includes(current.status)) {
      res.write(`event: done\ndata: ${JSON.stringify({ status: current.status })}\n\n`)
      done = true
      res.end()
    }
  }

  // Poll every 500ms
  const interval = setInterval(sendLogs, 500)
  
  // Also subscribe to Redis for immediate delivery (no 500ms delay)
  const sub = redis.duplicate()
  await sub.subscribe(`logs:${deployment.id}`)
  sub.on('message', async (channel, message) => {
    const log = JSON.parse(message)
    res.write(`data: ${JSON.stringify(log)}\n\n`)
  })

  req.on('close', () => {
    clearInterval(interval)
    sub.unsubscribe()
    sub.quit()
    done = true
  })
})
```

The dual mechanism — Redis pub/sub for real-time + DB polling as fallback — means logs appear instantly when the build is active, but the DB is always the source of truth for replay.

---

### Dashboard Visual Design Direction

The dashboard needs to look like a real developer tool, not a generic SaaS template. Take reference from Linear, Railway, and Vercel's own dashboard — dark backgrounds, tight typographic density, generous use of monospace for technical data.

**Color palette:**
- Background: `#0c0c0e` (near-black, not pure black)
- Surface: `#111113` (cards, sidebar)
- Border: `#1f1f23` (subtle dividers)
- Muted text: `#636369`
- Body text: `#e1e1e6`
- Accent: `#6366f1` (indigo-500 — used for links, active states, deploy button)
- Success: `#22c55e` (RUNNING status)
- Warning: `#f59e0b` (SLEEPING, BUILDING)
- Error: `#ef4444` (FAILED)

**Status badge design:**

```tsx
// components/StatusBadge.tsx
const statusConfig = {
  RUNNING:   { color: 'text-green-400',  bg: 'bg-green-400/10',  dot: 'bg-green-400',  pulse: true,  label: 'Running' },
  BUILDING:  { color: 'text-yellow-400', bg: 'bg-yellow-400/10', dot: 'bg-yellow-400', pulse: true,  label: 'Building' },
  QUEUED:    { color: 'text-blue-400',   bg: 'bg-blue-400/10',   dot: 'bg-blue-400',   pulse: false, label: 'Queued' },
  SLEEPING:  { color: 'text-zinc-400',   bg: 'bg-zinc-400/10',   dot: 'bg-zinc-400',   pulse: false, label: 'Sleeping' },
  WAKING:    { color: 'text-amber-400',  bg: 'bg-amber-400/10',  dot: 'bg-amber-400',  pulse: true,  label: 'Waking' },
  FAILED:    { color: 'text-red-400',    bg: 'bg-red-400/10',    dot: 'bg-red-400',    pulse: false, label: 'Failed' },
  STOPPED:   { color: 'text-zinc-500',   bg: 'bg-zinc-500/10',   dot: 'bg-zinc-500',   pulse: false, label: 'Stopped' },
  UPLOADING: { color: 'text-purple-400', bg: 'bg-purple-400/10', dot: 'bg-purple-400', pulse: true,  label: 'Uploading' },
  STARTING:  { color: 'text-cyan-400',   bg: 'bg-cyan-400/10',   dot: 'bg-cyan-400',   pulse: true,  label: 'Starting' },
  CANCELLED: { color: 'text-zinc-500',   bg: 'bg-zinc-500/10',   dot: 'bg-zinc-500',   pulse: false, label: 'Cancelled' },
}

export function StatusBadge({ status }: { status: keyof typeof statusConfig }) {
  const config = statusConfig[status]
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${config.color} ${config.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot} ${config.pulse ? 'animate-pulse' : ''}`} />
      {config.label}
    </span>
  )
}
```

**Sidebar:**

```
┌─────────────────────┐
│  ▲ dreamer          │  ← Logo + wordmark
├─────────────────────┤
│  ⌂  Overview        │
│  ⬡  Projects        │
│                     │
│  ─── ACCOUNT ───    │
│  ⚙  Settings        │
│  🔒 Security        │
├─────────────────────┤
│  [avatar] Saman     │  ← User avatar + name at bottom
│  saman@email.com    │
└─────────────────────┘
```

**Typography:** Use `Inter` for UI text, `JetBrains Mono` for the log viewer, commit hashes, slugs, and URLs. Both are Google Fonts, zero cost.

---

### What Makes This Dashboard Impressive to a Recruiter/Interviewer

The things that distinguish this from a generic CRUD dashboard:

1. **Real-time everything** — status badges update live via SSE without page refresh, log lines stream in as they happen, deployment pipeline animates through states

2. **State timeline on deployment detail** — showing exactly how long the deployment spent in each state (queue time, build time, upload time) is something real DevOps tools show. Most project dashboards don't think about this.

3. **Session management on /settings/security** — listing active sessions and letting users revoke them is a security feature most junior projects completely miss

4. **Audit log** — "who changed this env var and when" is a production operations concern, not a tutorial concern

5. **Env var reveal rate limiting + audit** — treating secrets correctly (never in page source, rate-limited decrypt, audit trail) shows production security thinking

6. **Empty state copy** — "No deployments yet. Push to GitHub or click Deploy to get started." beats a blank table

7. **The sleeping badge with wake indicator** — showing a deployment is sleeping with a "will wake on first request" tooltip demonstrates the scale-to-zero feature visually
