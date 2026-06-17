<div align="center">

<br />

```
██████╗ ██████╗ ███████╗ █████╗ ███╗   ███╗███████╗██████╗
██╔══██╗██╔══██╗██╔════╝██╔══██╗████╗ ████║██╔════╝██╔══██╗
██║  ██║██████╔╝█████╗  ███████║██╔████╔██║█████╗  ██████╔╝
██║  ██║██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║██╔══╝  ██╔══██╗
██████╔╝██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗██║  ██║
╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝
```

**A self-hosted PaaS that deploys any GitHub repo in under 3 minutes.**  
Static sites, SSR apps, and Node servers — on AWS or your own machine.

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-zinc.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)](https://typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?style=flat-square&logo=postgresql)](https://postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7-red?style=flat-square&logo=redis)](https://redis.io)
[![AWS](https://img.shields.io/badge/AWS-ECS%20%7C%20ECR%20%7C%20S3%20%7C%20ALB-orange?style=flat-square&logo=amazon-aws)](https://aws.amazon.com)

<br />

[**Live Demo**](https://dreamer.yourdomain.com) · [**Architecture Docs**](#architecture) · [**Self-Host Guide**](#self-hosting)

<br />

</div>

---

## What Is This

Dreamer is a deployment platform I built from scratch to understand how Vercel and Railway work under the hood. It accepts a GitHub repository URL and handles everything else: cloning, framework detection, building, containerizing (for dynamic apps), uploading (for static apps), subdomain routing, real-time log streaming, and scale-to-zero for idle services.

It runs on two execution engines selected by an environment variable — AWS ECS Fargate for cloud deployments, local Docker for bare-metal. Both engines implement the same interface, so the deployment pipeline is completely environment-agnostic.

This is not a tutorial project with renamed variables. It handles the problems that tutorials skip: state machine enforcement at the database level, thundering-herd prevention on container wake-up, per-deployment ALB listener rules for dynamic apps, encrypted secret storage with audit logging, and JWT refresh token rotation.

---

## Architecture

```
                        ┌─────────────────────────────────────────────┐
                        │              User Request                    │
                        │         *.dreamer.yourdomain.com             │
                        └─────────────────────┬───────────────────────┘
                                              │
                                    ┌─────────▼──────────┐
                                    │   Reverse Proxy     │
                                    │  (Wake-Up Proxy)    │
                                    │                     │
                                    │ Redis lookup:       │
                                    │ containerState:{id} │
                                    └──┬──────────────┬───┘
                                       │              │
                              RUNNING  │              │  SLEEPING
                                       │              │
                     ┌─────────────────▼──┐   ┌──────▼───────────────────┐
                     │   Static Site      │   │   Wake-Up Handler         │
                     │   (S3 Stream)      │   │                           │
                     │                   │   │  Browser → loading page   │
                     │   or              │   │  API client → 503 +       │
                     │   Dynamic App     │   │  Retry-After: 30          │
                     │   (ALB → ECS)     │   │                           │
                     └───────────────────┘   │  BullMQ wake job queued   │
                                             │  (SET NX — only one job   │
                                             │   fires for N requests)   │
                                             └──────────────────────────┘


  Deploy Flow:

  POST /projects/:id/deploy
           │
           ▼
  ┌─────────────────┐     ┌──────────────────────────────────────────────────────────┐
  │  API Server     │────▶│  BullMQ Queue  (Redis)                                   │
  │  (Express)      │     │                                                          │
  │                 │     │  concurrency: 3  ─── max 3 ECS builds simultaneously     │
  │  202 Accepted   │     │  attempts: 3     ─── exponential backoff on failure      │
  │  in < 5ms       │     │  limiter: 10/min ─── platform-wide rate cap             │
  └─────────────────┘     └──────────────────────┬───────────────────────────────────┘
                                                 │
                                       ┌─────────▼──────────┐
                                       │   Build Worker      │
                                       │                     │
                                       │  ExecutionEngine    │
                                       │  .build(job)        │
                                       └─────────┬───────────┘
                                                 │
                             ┌───────────────────┼──────────────────────┐
                             │                   │                      │
                    Framework Detection          │                      │
                             │                   │                      │
                    ┌────────▼──────┐   ┌────────▼───────┐   ┌─────────▼──────┐
                    │    STATIC     │   │  NEXT.JS SSR   │   │  NODE / EXPRESS │
                    │               │   │                │   │                 │
                    │ ECS RunTask   │   │ ECS RunTask    │   │ ECS RunTask     │
                    │ → npm build   │   │ → docker build │   │ → docker build  │
                    │ → S3 sync     │   │ → ECR push     │   │ → ECR push      │
                    │               │   │ → ECS Service  │   │ → ECS Service   │
                    │ {slug}.domain │   │ → ALB rule     │   │ → ALB rule      │
                    │ → S3 Proxy    │   │ {slug}.domain  │   │ {slug}.domain   │
                    │               │   │ → ALB → ECS    │   │ → ALB → ECS     │
                    └───────────────┘   └────────────────┘   └─────────────────┘
                                                 │
                                       ┌─────────▼──────────────────────────────┐
                                       │         Log Pipeline                    │
                                       │                                         │
                                       │  build-server → Redis pub/sub           │
                                       │  → API Server → SSE → browser          │
                                       │  → PostgreSQL (durable, searchable)    │
                                       └─────────────────────────────────────────┘


  Scale-to-Zero (Dynamic Apps):

  ┌─────────────────┐    60s poll    ┌──────────────────────────────┐
  │  Idle Detector  │───────────────▶│  SELECT * FROM Deployment    │
  │  (BullMQ job)   │                │  WHERE status = 'RUNNING'    │
  │                 │                │  AND type = 'DYNAMIC'        │
  │                 │                │  AND lastRequestAt < now()-15m│
  └────────┬────────┘                └──────────────────────────────┘
           │
           ▼
  ┌─────────────────┐
  │  Sleep Worker   │──▶ SET containerState:{id} = sleeping  (Redis)
  │                 │──▶ ECS UpdateService desiredCount: 0
  │                 │──▶ DB status → SLEEPING
  └─────────────────┘

  On next request:
  Reverse proxy → Redis key = sleeping → serve wake page
                                       → BullMQ wake job (SET NX — dedup)
                                       → ECS desiredCount: 1
                                       → poll until service stable
                                       → SET containerState:{id} = running
                                       → all queued requests unblocked
```

---

## Stack

| Layer | Technology | Why |
|---|---|---|
| **API Server** | Node.js, Express, TypeScript | Familiar, fast to iterate, good AWS SDK support |
| **Queue** | BullMQ + Redis | Persistent jobs, retry logic, concurrency limiting, visual dashboard |
| **Database** | PostgreSQL 16 + Prisma | State machine triggers enforced at DB layer, JSONB for metadata, tsvector for log search |
| **Build Runner** | ECS Fargate (RunTask) | Isolated per-build environment, no shared state, pay per second |
| **Dynamic App Runtime** | ECS Fargate (Service) + ALB | Persistent containers, health checks, per-deployment listener rules |
| **Static Hosting** | S3 + custom reverse proxy | Near-zero cost at scale, no cold starts |
| **Container Registry** | ECR | Native ECS integration, image scanning |
| **Cache / PubSub** | Redis (ioredis) | Log streaming, container state, idle detection keys, rate limiting |
| **Frontend** | Next.js 14, Tailwind CSS | RSC for data-heavy pages, SSE for live updates |
| **Auth** | JWT (15min access) + httpOnly refresh cookie | XSS-resistant, token rotation, session revocation |
| **Secrets** | AES-256-GCM per-value encryption | Secrets never stored in plaintext, IV per value |
| **Logging** | Pino (structured JSON) | Searchable in CloudWatch, consistent field names |

---

## Features

### Deployment Engine

- **Auto-detects framework** from `package.json` — React (CRA/Vite), Vue, Svelte, Next.js (static export vs SSR), Express, Fastify, plain HTML. No config file required.
- **Two infrastructure paths** based on detection:
  - Static apps → ephemeral ECS build task → S3 → reverse proxy. No running container, no cost at rest.
  - Dynamic apps → ECS build task → Docker image → ECR → persistent ECS Service → ALB with per-deployment host-based routing rule.
- **Generates a Dockerfile** for dynamic apps that don't provide one. Multi-stage builds for Next.js SSR (builder → runner, ~200MB final image). Single-stage for Express.
- **Environment variable injection** — secrets stored AES-256-GCM encrypted in Postgres, decrypted at deploy time and injected as ECS task environment variables. Build snapshots capture which secrets were active at deploy time, enabling accurate rollback.
- **Rollback** — re-queues any previous deployment with its original commit hash and env snapshot. One click in the dashboard.

### Real-Time Observability

- **Live build logs** stream from ECS task → Redis pub/sub → SSE → browser as they happen, with sequence numbers for correct ordering and gapless replay.
- **Dual delivery**: Redis pub/sub for < 100ms latency while the build is active; PostgreSQL as durable storage for replay after the fact. If you refresh mid-build, logs replay from the DB with no gaps.
- **State timeline** on every deployment — shows exactly how long was spent queued, building, uploading, and starting, with timestamps on each transition. Pulled from an append-only `DeploymentStateTransition` table.
- **Full-text search** across build logs via PostgreSQL `tsvector` index. Find every deployment where `MODULE_NOT_FOUND` appeared without scanning rows.

### Scale-to-Zero

Dynamic app deployments that receive no traffic for 15 minutes are automatically scaled to `desiredCount: 0` on ECS — no running task, no Fargate charges. On the next inbound request:

- The reverse proxy checks `containerState:{id}` in Redis (single microsecond lookup)
- Browser clients receive an HTML loading page with 3-second polling — the same UX Railway uses
- API clients (curl, mobile, fetch) receive `503 + Retry-After: 30`
- A BullMQ wake job is enqueued using `SET NX` — regardless of how many concurrent requests arrive, exactly one wake job fires
- ECS scales back to `desiredCount: 1`, the proxy polls until the health check passes, then all buffered requests go through normally

Fargate cold start is 15–30 seconds depending on image size. Smaller images (alpine base, multi-stage build) are prioritized.

### Platform

- **BullMQ queue** between HTTP handler and ECS dispatch — `/deploy` returns `202 Accepted` in under 5ms, never blocks. Configurable concurrency (default: 3 simultaneous builds) and rate limit (default: 10 builds/minute platform-wide).
- **Bull Board** at `/admin/queues` — live dashboard showing pending, active, completed, and failed build jobs. Useful for debugging stuck deployments.
- **GitHub webhook auto-deploy** — HMAC-verified, delivery logged, duplicate-deployment guard (won't queue if a build is already in progress for the same project).
- **Session management** — users can view all active sessions with device, IP, and last-seen time, and revoke any of them individually. Password change invalidates all sessions.
- **Audit log** — every sensitive action (login, env var reveal, project delete, deployment stop) recorded with user ID, IP, and timestamp.
- **Dual execution engine** — `DEPLOYMENT_ENVIRONMENT=cloud` routes to AWS; `DEPLOYMENT_ENVIRONMENT=bare_metal` routes to local Docker + NGINX. Both implement the same `ExecutionEngine` interface; the BullMQ worker has zero knowledge of the environment.

---

## Project Structure

```
dreamer/
├── apps/
│   ├── api/              # Express API server + BullMQ workers
│   │   └── prisma/       # Schema + migrations
│   ├── build-engine/     # ECS task: clone → detect → build → upload/push
│   ├── reverse-proxy/    # Subdomain router + wake-up proxy
│   └── frontend/         # Next.js 14 dashboard
├── infra/                # AWS CDK infrastructure definitions
├── docker-compose.yml    # Local dev: PostgreSQL + Redis
└── turbo.json            # Turborepo build graph
```

---

## Self-Hosting

### Prerequisites

- AWS account with ECS, ECR, S3, ALB, Route53 access
- A domain with wildcard DNS support (`*.yourdomain.com`)
- Node.js 20+, Docker, pnpm

### 1. Clone and install

```bash
git clone https://github.com/SamanPandey-in/dreamer.git
cd dreamer
pnpm install
```

### 2. Configure environment

```bash
cp apps/api/.env.example apps/api/.env
cp apps/build-engine/.env.example apps/build-engine/.env
cp apps/reverse-proxy/.env.example apps/reverse-proxy/.env
cp apps/frontend/.env.example apps/frontend/.env.local
```

Fill in your AWS credentials, region, ECS cluster ARN, ECR registry URL, S3 bucket name, ALB listener ARN, and base domain. Generate secrets:

```bash
# JWT secrets (run twice for two different values)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# AES-256 encryption key for secrets storage
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Start local services

```bash
docker compose up -d   # PostgreSQL + Redis
```

### 4. Initialize the database

```bash
cd apps/api
pnpm prisma migrate deploy
pnpm prisma generate
```

### 5. Build and push the build-engine image to ECR

The build-engine runs as an ECS Fargate task. It needs to be in ECR before your first deployment.

```bash
cd apps/build-engine

# Authenticate with ECR
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin YOUR_ECR_REGISTRY

# Build and push
docker build -t dreamer-build-engine .
docker tag dreamer-build-engine:latest YOUR_ECR_REGISTRY/dreamer-build-engine:latest
docker push YOUR_ECR_REGISTRY/dreamer-build-engine:latest
```

Register the ECS task definition using the ARN from the push above, then put that task definition ARN in your `.env`.

### 6. Set up wildcard DNS

In Route53 (or your DNS provider), add:

```
*.dreamer.yourdomain.com  →  A  →  your reverse proxy server IP
```

For HTTPS, provision a wildcard certificate in AWS Certificate Manager: `*.dreamer.yourdomain.com`.

### 7. Run

```bash
# Development (all services with hot reload)
pnpm dev

# Production (individual services, each in its own process/container)
pnpm --filter api start
pnpm --filter reverse-proxy start
pnpm --filter frontend start
```

---

## API Reference

### Authentication

```http
POST /auth/register
Content-Type: application/json

{ "email": "you@example.com", "password": "...", "name": "Your Name" }
```

```http
POST /auth/login
Content-Type: application/json

{ "email": "you@example.com", "password": "..." }

# Response:
# { "accessToken": "eyJ...", "user": { ... } }
# Set-Cookie: refreshToken=...; HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh
```

```http
POST /auth/refresh
# Cookie: refreshToken=...

# Response: new accessToken + rotated refreshToken cookie
```

### Projects

```http
# List projects (with latest deployment)
GET /projects
Authorization: Bearer <access_token>

# Create project
POST /projects
Authorization: Bearer <access_token>

{
  "name": "my-app",
  "repoUrl": "https://github.com/you/my-app",
  "defaultBranch": "main"
}

# Trigger deployment
POST /projects/:id/deploy
Authorization: Bearer <access_token>

{ "branch": "main" }

# Response: 202 Accepted
# { "deploymentId": "uuid", "slug": "fuzzy-cat-42", "url": "https://fuzzy-cat-42.dreamer.com" }
```

### Deployments

```http
# Deployment detail + state timeline
GET /deployments/:id
Authorization: Bearer <access_token>

# Paginated log history
GET /deployments/:id/logs?after=0&limit=100
Authorization: Bearer <access_token>

# Live log stream (SSE)
GET /deployments/:id/logs/stream
Authorization: Bearer <access_token>
Accept: text/event-stream

# Stop deployment
POST /deployments/:id/stop
Authorization: Bearer <access_token>

# Rollback (re-deploys with original commit + env snapshot)
POST /deployments/:id/rollback
Authorization: Bearer <access_token>
```

### Environment Variables

```http
# List (values masked)
GET /projects/:id/env
Authorization: Bearer <access_token>

# Create or upsert
POST /projects/:id/env
Authorization: Bearer <access_token>

{ "key": "DATABASE_URL", "value": "postgresql://...", "isSecret": true }

# Reveal a value (rate-limited: 10/hour, audit-logged)
POST /env/:id/reveal
Authorization: Bearer <access_token>
```

---

## Design Decisions

**Why BullMQ instead of SQS?** SQS would work, but BullMQ gives per-job retry configuration, concurrency control, the Bull Board UI, and priority queues — all without additional AWS cost or IAM complexity. For a single-region deployment, Redis is the simpler dependency.

**Why SSE instead of WebSocket for log streaming?** Log streaming is one-directional: server to client. SSE is HTTP/1.1-compatible, auto-reconnects, works through proxies without upgrade headers, and saves ~40KB of client JS (no socket.io). The only thing WebSocket adds here is complexity.

**Why PostgreSQL tsvector for log search instead of Elasticsearch?** At the scale this platform operates, full-text search via a GIN-indexed `tsvector` column in PostgreSQL handles it fine. Elasticsearch would add operational overhead (another service, another failure mode) for the same query results. If this were indexing millions of deployments, the calculus changes.

**Why AES-256-GCM with a per-value IV instead of a single column-level encryption key?** GCM provides authenticated encryption — if the ciphertext is tampered with, decryption fails with an authentication error rather than producing garbage. Per-value IVs mean that two identical secrets produce different ciphertexts, so an attacker with DB access can't do a dictionary attack by comparing columns.

**Why are state transitions enforced with a Postgres trigger?** Application-layer validation breaks under race conditions: two BullMQ workers processing retry attempts of the same job can both attempt to transition `QUEUED → BUILDING`. A database trigger either succeeds or raises an exception — no in-between. The BullMQ worker catches the exception and treats it as a signal that another worker already claimed the job.

**Why per-deployment ALB listener rules instead of a shared rule with path-based routing?** Host-based routing (`fuzzy-cat-42.dreamer.com`) maps naturally to how users think about their apps. Path-based routing (`dreamer.com/apps/fuzzy-cat-42/`) would require modifying app code to handle the path prefix. One listener rule per deployment is more AWS resources, but it's the correct UX tradeoff.

---

## What I Learned Building This

The problems that were harder than expected:

**The wake-up proxy thundering herd.** The obvious implementation — check if sleeping, start the container, wait, respond — breaks when 50 requests arrive in a 100ms window. You end up with 50 simultaneous `UpdateService` calls and 50 competing pollers. The fix (Redis `SET NX` as a distributed mutex, with all waiting requests sharing one poll loop) took three rewrites to get right.

**Log sequence ordering.** Redis pub/sub delivers messages in order within a connection, but if the connection drops and reconnects, you might miss lines. The sequence number column in `DeploymentLog` means the client can always request "give me everything after sequence N" and get a gapless replay — pub/sub is for latency, the DB is for correctness.

**The static vs dynamic split is not binary.** Next.js with `output: 'export'` in `next.config.js` produces a static site just like Create React App. Next.js without it needs a running Node process. The framework detector has to read the Next.js config (which might be JS, TS, or CJS), not just check for the `next` dependency in package.json.

**ECS Fargate cold start is the dominant latency source.** Everything else in the wake-up path (Redis lookup, DB query, ALB rule lookup) is under 10ms. ECS provisioning a new microVM, pulling the image from ECR, and passing health checks takes 15–30s. Smaller images help: a 50MB alpine-based image pulls in ~3s; a 500MB Ubuntu-based image takes 20s+.

---

## Deployment Status Reference

| Status | Description | Next States |
|---|---|---|
| `QUEUED` | Build job created, waiting for a worker | `BUILDING`, `CANCELLED`, `FAILED` |
| `BUILDING` | ECS task running npm install + npm build | `UPLOADING` (static), `STARTING` (dynamic), `FAILED` |
| `UPLOADING` | Syncing dist/ to S3 | `RUNNING`, `FAILED` |
| `STARTING` | ECS service created, container starting | `RUNNING`, `FAILED` |
| `RUNNING` | App live and serving requests | `SLEEPING`, `STOPPED`, `FAILED` |
| `SLEEPING` | ECS scaled to 0, wakes on first request | `WAKING`, `STOPPED` |
| `WAKING` | ECS scaling back up, wake proxy holding requests | `RUNNING`, `FAILED`, `STOPPED` |
| `STOPPED` | Manually stopped or replaced by newer deployment | — |
| `FAILED` | Any step errored — see `errorCode` + `errorMessage` | — |
| `CANCELLED` | Queued but cancelled before worker picked it up | — |

---

## Roadmap

- [ ] GitHub OAuth and webhook auto-deploy
- [ ] Branch preview deployments (every PR gets its own URL)
- [ ] Custom domain support with automatic SSL via ACM
- [ ] Bare-metal execution engine (local Docker + NGINX)
- [ ] Prometheus metrics endpoint + Grafana dashboard
- [ ] Deploy usage analytics (requests/day, bandwidth, cold starts)
- [ ] Team support (invite members to projects, role-based access)
- [ ] Deploy from private repositories
- [ ] Build cache (S3-backed `node_modules` cache keyed by `package-lock.json` hash)

---

## Local Development

```bash
# Install dependencies
pnpm install

# Start PostgreSQL and Redis
docker compose up -d

# Run database migrations
cd apps/api && pnpm prisma migrate dev

# Start all services in development mode (hot reload)
pnpm dev

# Run tests
pnpm test

# Type-check the entire monorepo
pnpm typecheck
```

The development setup runs without AWS — the bare-metal engine uses local Docker. Set `DEPLOYMENT_ENVIRONMENT=bare_metal` to use it.

---

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

Built by [Saman Pandey](https://github.com/SamanPandey-in)  
Computer Science, VESIT Mumbai

*If you're reading this as a recruiter: the interesting parts are the scale-to-zero wake-up proxy, the database-level state machine trigger, and the dual execution engine abstraction. Happy to walk through any of it.*

</div>