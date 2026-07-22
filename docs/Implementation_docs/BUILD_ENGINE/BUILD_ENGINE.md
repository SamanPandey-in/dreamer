# How the build engine works

This document covers the entire lifecycle of Dreamer's build engine — the Node.js application that runs inside an ECS Fargate container, clones a git repository, installs dependencies, runs the build, and uploads the output to S3. It's written in first-person narrative so you can follow the reasoning, not just the code paths.

---

## Table of Contents

1. [What the build engine is](#1-what-the-build-engine-is)
2. [The Docker image](#2-the-docker-image)
3. [How the ECS task gets launched](#3-how-the-ecs-task-gets-launched)
4. [Entry point: main.sh → script.js](#4-entry-point-mainsh--scriptjs)
5. [Phase 1: Clone](#5-phase-1-clone)
6. [Phase 2: Install + Build](#6-phase-2-install--build)
7. [Phase 3: Upload to S3](#7-phase-3-upload-to-s3)
8. [Real-time communication via Redis PubSub](#8-real-time-communication-via-redis-pubsub)
9. [Status lifecycle](#9-status-lifecycle)
10. [How user environment variables reach the build container](#10-how-user-environment-variables-reach-the-build-container)
11. [The stop / cancellation path](#11-the-stop--cancellation-path)
12. [Dynamic deployments](#12-dynamic-deployments)

---

## 1. What the build engine is

The build engine is a plain Node.js application (CommonJS, no TypeScript) that lives in `apps/build-engine/`. Its only job: given a git URL and a branch, clone the repo, run `npm install && npm run build` (or whatever custom commands the project configures), and upload the result to S3.

It runs as a one-off ECS Fargate task — not a long-lived service. When the task finishes (success or failure), the container exits. There is no daemon, no health check, no load balancer. The API server launches it, the build engine reports progress via Redis, and when it's done, it's done.

The engine has exactly three source files (plus `main.sh`):

- **`script.js`** — the main entry point, orchestrates the three phases
- **`clone-repo.js`** — git operations: clone, checkout, credential management
- **`redis.js`** — PubSub helper for reporting logs and status back to the API server

---

## 2. The Docker image

The Dockerfile at `apps/build-engine/Dockerfile` builds the image that ECS runs:

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache git bash
WORKDIR /home/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN chmod +x main.sh
ENTRYPOINT ["/home/app/main.sh"]
```

Key decisions:

- **`node:22-alpine`** — small image, fast pull on ECS. The `alpine` variant keeps the image under 200MB.
- **`apk add git bash`** — `git` is needed for cloning. `bash` is only used for `main.sh` (a two-line shell script); the build engine itself is pure Node.
- **Two-step COPY** — `package*.json` first, then `npm ci`, then the rest of the source. This layers the Docker build cache so that dependency install only re-runs when `package.json` or `package-lock.json` changes — not every time `script.js` or `clone-repo.js` gets edited.
- **`.dockerignore`** excludes `.env` and `.env.local` so local secrets don't end up in the image.

Dependencies are minimal — just three packages:

| Package | Purpose |
|---------|---------|
| `@aws-sdk/client-s3` | S3 upload of build output |
| `ioredis` | PubSub reporting to the API server |
| `mime-types` | Content-Type detection for S3 uploads |

No framework, no Express, no HTTP server — the engine doesn't listen on any port. It does its work and exits.

---

## 3. How the ECS task gets launched

The API server's `EcsDeploymentEngine` in `apps/api-server/src/deployments/deployment-engine.ts` builds a `RunTaskCommand` and sends it to ECS:

```ts
const command = new RunTaskCommand({
  cluster: env.ECS_CLUSTER_ARN,
  taskDefinition: env.ECS_TASK_DEFINITION_ARN,
  launchType: 'FARGATE',
  count: 1,
  networkConfiguration: {
    awsvpcConfiguration: {
      assignPublicIp: 'ENABLED',
      subnets: [env.ECS_SUBNET1_ARN, env.ECS_SUBNET2_ARN, env.ECS_SUBNET3_ARN],
      securityGroups: env.ECS_SECURITY_GROUP_ARN ? [env.ECS_SECURITY_GROUP_ARN] : [],
    },
  },
  overrides: {
    containerOverrides: [{
      name: env.TASK_DEFINITION_IMAGE_NAME,
      environment: [ /*...*/ ],
    }],
  },
});
```

The task definition lives in AWS, not in code. The API server references it by ARN via `env.ECS_TASK_DEFINITION_ARN`. The task definition points to the Docker image built from `apps/build-engine/Dockerfile`, but the API server doesn't build or push that image — that's handled externally (CI/CD, manual push, etc.).

All configuration is passed through **container overrides** — environment variables injected at task run time. This is the only mechanism the build engine uses for input. There is no config file, no API call, no database connection. The env vars control everything:

| Env var | Purpose |
|---------|---------|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS credentials for S3 upload |
| `AWS_REGION` | AWS region |
| `REDIS_URL` | Redis connection for status reporting |
| `GIT_REPOSITORY_URL` | The repo to clone |
| `BRANCH` | Branch to build |
| `DEPLOYMENT_ID` | UUID — used as the Redis PubSub channel name |
| `PROJECT_SLUG` | Used as the S3 key prefix and deployment URL subdomain |
| `COMMIT_HASH` | (Optional) Pin to a specific commit for rollbacks |
| `GIT_ACCESS_TOKEN` | (Optional) GitHub token for private repos |
| `ROOT_DIRECTORY` | Monorepo subdirectory |
| `INSTALL_COMMAND` | Custom install command |
| `BUILD_COMMAND` | Custom build command |
| `OUTPUT_DIRECTORY` | Build output folder name |
| `DEPLOYMENT_TYPE` | `STATIC` or `DYNAMIC` — decides post-build path |
| `FRAMEWORK` | Framework name (for dynamic Dockerfile resolution) |
| `ECR_REPOSITORY_URI` | (Dynamic only) Where Kaniko pushes the image |
| *User env vars* | The project's own environment variables (see §10) |

**Why env vars instead of an API call or a config file?** Because Fargate tasks are ephemeral and stateless. An env var is the simplest contract between the API server and the build engine — no shared volume, no startup race, no HTTP server inside the build container. The "request" is the task launch, and the env vars are the payload.

---

## 4. Entry point: main.sh → script.js

### main.sh

```bash
#!/bin/bash
exec node script.js
```

Two lines. `exec` replaces the shell process with Node so signals propagate correctly — when ECS sends `SIGTERM` on stop, it goes directly to the Node process, not to a shell that might or might not forward it.

### script.js

`script.js` is the orchestrator. Its `init()` function runs the three phases sequentially:

```
init()
  ├── writeNetrcIfNeeded()      # GitHub token → ~/.netrc
  ├── runClone()                # git clone
  ├── runCheckoutIfPinned()     # git checkout (rollback)
  ├── scrubNetrc()              # remove ~/.netrc before npm
  ├── getCommitInfo()           # best-effort git log
  ├── getBuildContextPath()     # resolve monorepo subdirectory
  ├── runShellCommand(INSTALL)  # npm install (or custom)
  ├── runShellCommand(BUILD)    # npm run build (or custom)
  ├── verify output directory
  ├── upload to S3
  └── publishStatus('RUNNING')
```

Every major step publishes a log line via Redis, so the dashboard shows real-time progress. If any step throws, the error is caught, a `FAILED` status is published with the failing step's name (`install`, `build`, `upload`), and the process exits with code 1.

---

## 5. Phase 1: Clone

Defined in `clone-repo.js`.

### 5a. GitHub token handling

If the repo is private, `writeNetrcIfNeeded()` writes the `GIT_ACCESS_TOKEN` to `~/.netrc`:

```
machine github.com
login x-access-token
password <token>
```

I chose `~/.netrc` over embedding the token in the clone URL because git echoes error messages with the URL it attempted. If the token were in the URL, a failed clone would print the token to the build log. With `.netrc`, git prints the plain URL, and the token stays off the wire.

`scrubNetrc()` deletes `.netrc` **before** npm runs — a defense-in-depth measure. Without this, any compromised or malicious npm package in the dependency tree could read a live GitHub token off the filesystem during its postinstall script. Scrubbing it before `npm install` closes that window completely. The function is called again in the `finally` block as a safety net.

### 5b. The clone itself

```js
exec(`git clone --branch "${BRANCH}" --single-branch "${GIT_REPOSITORY_URL}" "${targetPath}"`)
```

Clones into `/home/app/output` — a fixed path inside the container. `--single-branch` fetches only the target branch's history (no other refs), which keeps the clone fast. Notably there's no `--depth` flag, so the full history of that branch is available — which matters for rollbacks (see §5c).

The `targetPath` is hardcoded to `/home/app/output`. I didn't make it configurable because there's no need — it's internal to the container and never exposed to the user. The user-facing concept of "output directory" (see Phase 2) is about where the build framework writes its artifacts, which is a different thing entirely.

### 5c. Rollback support

When `COMMIT_HASH` is set (only for rollback deployments), `runCheckoutIfPinned()` runs:

```bash
git -C /home/app/output checkout <commitHash>
```

Because `--single-branch` without `--depth` fetches full history, any commit ever reachable from that branch's tip at clone time is checkoutable. If the commit has been force-pushed out of the branch's history, the checkout fails with a clear message.

Design constraint: this is explicitly a **rebuild**, not a traffic re-point. The build engine clones the repo, checks out the old commit, and runs the full install+build+upload cycle. The output overwrites the same S3 prefix that every deployment of this project writes to (see §7).

### 5d. Commit info

After cloning (and optional pinning), `getCommitInfo()` runs `git log -1` and reports the hash, message, and author via Redis. This is best-effort — if it fails (corrupted repo, empty history), the build continues. The commit info is persisted on the `Deployment` row by the API server's `recordCommitInfo()`.

---

## 6. Phase 2: Install + Build

### 6a. `runShellCommand`

Both install and build run through a shared `runShellCommand(command, cwd)` function:

```js
function runShellCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const p = exec(command, { cwd })
    p.stdout.on('data', (data) => { console.log(data); publishLog(data) })
    p.stderr.on('data', (data) => { console.error(data); publishLog(data, 'WARN') })
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Command "${command}" exited with code ${code}`))
    })
  })
}
```

I keep stdout and stderr separate in the Redis log (stderr gets level `WARN` instead of `INFO`) because npm and many build tools print warnings and progress to stderr that aren't actual errors. The exit code is what decides pass/fail — not which stream a line happened to print to.

The build context directory (`cwd`) is the cloned repo root by default, or a subdirectory if `ROOT_DIRECTORY` is set (monorepo support).

### 6b. Build config overrides

Three env vars override the default commands:

| Env var | Default | User sets via |
|---------|---------|---------------|
| `INSTALL_COMMAND` | `npm ci --legacy-peer-deps` | Dashboard → Build Settings |
| `BUILD_COMMAND` | `npm run build` | Dashboard → Build Settings |
| `OUTPUT_DIRECTORY` | `dist` | Dashboard → Build Settings |

Trailing/leading quotes are stripped (the user dashboard may include them). If a field is null in the database (the project was created before build config existed, or the user never set it), the empty string is sent and the fallback takes effect.

**Why two separate `exec()` calls instead of one `&&` chain?** Because `Deployment.errorStep` exists precisely to answer "which step failed: install or build?" A single chained command would make that column impossible to populate correctly. Each step is wrapped in its own try/catch that attaches `.step = 'install'` or `.step = 'build'` before rethrowing.

---

## 7. Phase 3: Upload to S3

After the build succeeds, `script.js` reads the output directory recursively and uploads every file to S3:

```js
const command = new PutObjectCommand({
  Bucket: S3_BUCKET,
  Key: `__outputs/${PROJECT_SLUG}/${file}`,
  Body: fs.createReadStream(filePath),
  ContentType: mime.lookup(filePath) || 'application/octet-stream',
})
```

Key details:

- **S3 prefix is `__outputs/{PROJECT_SLUG}/`**, not `__outputs/{DEPLOYMENT_ID}/`. Every deployment of the same project overwrites the same prefix. This is deliberate: the reverse proxy (`apps/reverse-proxy`) maps subdomain → S3 prefix, and the subdomain a user visits *is* the project slug. No routing table, no mapping, no traffic re-pointing needed — the latest build is always live at `{project-slug}.{base-domain}`.
- **Content-Type is auto-detected** via the `mime-types` package. Without this, S3 defaults to `binary/octet-stream`, which breaks JS/CSS in the browser.
- **Uploads are sequential** (one `await` per file), not parallel. This is intentionally conservative — the build engine runs on Fargate with modest CPU/memory, and the S3 bucket is in the same region. Parallel uploads would add complexity (error handling, retry logic) without meaningful speedup for typical project sizes.
- **`fs.readdirSync` with `recursive: true`** (Node 22) walks the entire output tree. A safety check verifies the output directory exists before the upload loop starts — if the framework didn't produce it, the user gets a clear error instead of an empty S3 prefix and a confusing "success."

After all files are uploaded, the engine publishes a `RUNNING` status with the deployment URL and the file count:

```js
publishStatus('RUNNING', { url, uploadedFileCount })
```

The `uploadedFileCount` powers the Build Summary card in the dashboard.

---

## 8. Real-time communication via Redis PubSub

The build engine and the API server never talk to each other directly. There's no HTTP call from the container back to the API server, no webhook, no polling. Communication happens entirely through Redis PubSub.

### Producer: build-engine (`redis.js`)

The build engine opens a single Redis connection and publishes JSON messages to channel `deployment:{DEPLOYMENT_ID}`:

```js
const CHANNEL = `deployment:${process.env.DEPLOYMENT_ID}`
```

Three message types share this channel, disambiguated by a `type` field:

| Type | Shape | When sent |
|------|-------|-----------|
| `log` | `{ type: 'log', level, message, source }` | stdout/stderr from build steps, system messages |
| `status` | `{ type: 'status', status, url?, errorCode?, errorMessage?, errorStep?, uploadedFileCount? }` | Status transitions |
| `commit_info` | `{ type: 'commit_info', commitHash, commitMessage?, commitAuthor? }` | Once after clone |

The Redis connection is fire-and-forget. On process exit, the `finally` block allows 250ms for the last message to flush:

```js
setTimeout(() => publisher.quit(), 250)
```

### Consumer: API server (`log-relay.ts`)

The API server runs a dedicated Redis subscriber (separate from Socket.IO) that listens to the `deployment:*` pattern via `psubscribe`:

```js
const subscriber = new Redis(env.REDIS_URL)
await subscriber.psubscribe('deployment:*')
```

When a message arrives, `log-relay.ts` routes it based on `type`:

- **`log`** — persists to `DeploymentLog` via `appendLogLine()`, then emits to the dashboard's Socket.IO room `deployment:{id}`
- **`status`** — persists the status transition via `transitionDeploymentStatus()`, then emits the updated status to the dashboard
- **`commit_info`** — persists commit metadata on the `Deployment` row via `recordCommitInfo()` (no Socket.IO emit — the dashboard page re-fetches on mount)

This architecture means the build engine never imports the Prisma client, never knows about Socket.IO, and never depends on any API server code. The contract is just JSON on a Redis channel.

---

## 9. Status lifecycle

A deployment moves through these statuses:

```
QUEUED ──> BUILDING ──> UPLOADING ──> RUNNING
   │                                        │
   │  (engine launch fails)                 │
   └──> FAILED                              │
                                            │
                 (user stops deployment)    │
              ┌─────────────────────────────┘
              ▼
          STOPPED
```

| Status | When set by build-engine | What's happening |
|--------|--------------------------|------------------|
| `QUEUED` | — (set by API server on deploy) | Row created, ECS task not yet launched |
| `BUILDING` | Start of `init()` | Cloning repo, installing dependencies |
| `UPLOADING` | After build succeeds | Uploading output to S3 |
| `RUNNING` | After all files uploaded | Deployment is live (for STATIC) |
| `FAILED` | On any thrown error | Build failed at `install`, `build`, or `upload` step |

Transitions are persisted via `transitionDeploymentStatus()` in the API server, which also:
- Sets `buildStartedAt` on first `BUILDING` transition
- Sets `buildFinishedAt` and `buildDurationMs` on `UPLOADING`/`STARTING`
- Sets `deployedAt` on `RUNNING`
- Sets `activeDeploymentId` on the Project when a deployment reaches `RUNNING`
- Creates a `DeploymentStateTransition` audit record for every change

---

## 10. How user environment variables reach the build container

*This section is adapted from `BUILD_ENGINE_ENV.md`.*

User-configured project env vars (set in the dashboard under Project > Environment Variables) flow from the database into the ECS build container through this path:

### 10a. `resolveProjectEnvVarsForEnvironment` — `deployment.service.ts:124`

When `createDeploymentInternal` starts a deployment, it resolves the project's env vars for this specific environment:

```ts
async function resolveProjectEnvVarsForEnvironment(projectId, environment) {
  const envVars = await prisma.envVariable.findMany({
    where: { projectId, environments: { has: environment } },
  });
  return envVars.map((envVar) => ({
    name: envVar.key,
    value: decryptFromColumn({ value: envVar.value, iv: envVar.iv }),
  }));
}
```

It reads every `EnvVariable` row whose `environments` array includes the target environment (`PRODUCTION` or `PREVIEW`), then decrypts the stored ciphertext using the IV saved alongside it.

Why resolve here instead of inside `deployment-engine.ts`? Keeping `EcsDeploymentEngine` free of Prisma and crypto was an explicit design choice. It takes a `BuildJob` and talks to ECS — that's it. Swapping in a different engine (local Docker, a mock for tests) shouldn't require bringing along a database connection or an encryption key.

### 10b. Passed into `launchBuildTask` — `deployment.service.ts:239`

```ts
const handle = await deploymentEngine.launchBuildTask({
  deploymentId: deployment.id,
  projectSlug: project.slug,
  userEnvVars,   // <-- the decrypted array from step 1
  ...
});
```

Just one more field on the `BuildJob` interface.

### 10c. Spread into ECS container overrides — `deployment-engine.ts:201`

```ts
environment: [
  { name: 'AWS_ACCESS_KEY_ID', value: env.AWS_ACCESS_KEY_ID },
  { name: 'REDIS_URL', value: env.REDIS_URL },
  // ... more platform vars ...
  ...job.userEnvVars.map((v) => ({ name: v.name, value: v.value })),
],
```

ECS container overrides set OS-level environment variables inside the running container. They're not files, not Secrets Manager references — just plain `KEY=VALUE` pairs, the same as `docker run -e FOO=bar`.

User vars are spread **last** so a collision with a reserved prefix is structurally impossible — `RESERVED_ENV_KEY_PREFIXES` catches it at creation time.

### 10d. The build container inherits them automatically — `script.js:47`

The build engine never reads user env vars explicitly — it doesn't need to. ECS sets them as OS env vars → Node.js `process.env` has them. When `runShellCommand` spawns the build process:

```js
function runShellCommand(command, cwd) {
  const p = exec(command, { cwd })
  // ...
}
```

`child_process.exec` with no explicit `env` option means the child inherits the parent's full `process.env` — including every user env var. So when `npm run build` runs, any variable the project owner configured in the dashboard is available as an environment variable, the same as a `.env` file would be in local development.

### 10e. Dynamic deployments also get them at runtime — `deployment-engine.ts:261`

For DYNAMIC deployments, the same `userEnvVars` array is also set on the Lambda function's `Environment.Variables` in `deployDynamicApp`:

```ts
const environmentVariables: Record<string, string> = {
  PORT: '3000',
  HOSTNAME: '0.0.0.0',
  AWS_LWA_INVOKE_MODE: 'response_stream',
  NODE_ENV: 'production',
  ...Object.fromEntries(job.userEnvVars.map((v) => [v.name, v.value])),
};
```

This is the **runtime** Lambda — the running app that answers HTTP requests — not the build task. Same env vars, different destination. Both are sourced from the same `resolveProjectEnvVarsForEnvironment` call.

### Summary table

| Step | File | Line | What happens |
|------|------|------|-------------|
| Read + decrypt | `deployment.service.ts` | 124–136 | Queries `EnvVariable` table, decrypts values |
| Pass to engine | `deployment.service.ts` | 239 | `userEnvVars` field on `BuildJob` |
| ECS overrides | `deployment-engine.ts` | 201 | Spread into `RunTaskCommand` container environment |
| Available in build | `script.js` (build-engine) | 47–73 | Inherited by child `exec()` — no explicit read needed |
| Lambda runtime (dynamic only) | `deployment-engine.ts` | 266 | Also set on the deployed Lambda function |

---

## 11. The stop / cancellation path

When a user clicks "Stop" on a deployment in the dashboard, the API server's `stopDeployment` determines what to do based on the current status:

**If the ECS task is still running** (`BUILDING`, `UPLOADING`, or the ECS-task-existed-but-was-already-running branch):

```ts
if (IN_FLIGHT_BUILD_STATUSES.includes(deployment.status) && deployment.ecsTaskArn) {
  await deploymentEngine.stopBuildTask(deployment.ecsTaskArn);
}
```

`stopBuildTask` sends `StopTaskCommand` to ECS with reason `"Stopped by user via Dreamer dashboard"`. ECS sends `SIGTERM` to the container, and the `finally` block in `script.js` runs `scrubNetrc()` and flushes the Redis connection before the process exits.

**If the deployment was already `QUEUED`** (task not yet launched):

```ts
if (deployment.status === 'QUEUED') {
  // transition to CANCELLED — no ECS task to stop
}
```

**If the deployment was already `RUNNING`** (for STATIC — the build finished long ago):

```ts
// Only the CURRENT active deployment can be stopped (others are already
// superseded, stopping them would be meaningless).
// Delete the S3 prefix and clear activeDeploymentId on the project.
```

Important design note: the stop path is written to be safely callable even if the task already exited — `StopTaskCommand` is idempotent on ECS's side, and `ResourceNotFoundException` from Lambda operations is caught and swallowed. This means the dashboard's "stop" button can be pressed speculatively without first checking live state.

---

## 12. Dynamic deployments

For `DEPLOYMENT_TYPE=DYNAMIC` (Next.js SSR and other server-rendered frameworks), the build engine's post-build path diverges from the S3 upload described in §7. The dynamic path is:

1. Resolve a Dockerfile template based on `FRAMEWORK` (see `dockerfile-resolver.js`)
2. Build a container image using Kaniko (in-cluster, no Docker daemon needed)
3. Push the image to ECR at `{ECR_REPOSITORY_URI}:{PROJECT_SLUG}`
4. Publish an `image_ready` event to Redis

The API server's `handleImageReady` handler then calls `deployDynamicApp` which creates (or updates) a Lambda function from the pushed image and sets up a Function URL.

The dynamic path is covered in detail in [`SSR_SUPPORT.md`](./SSR_SUPPORT.md). This document focuses on the core build engine, so I won't repeat that here — but the key point is that the three-phase structure (clone → build → publish) is the same for both deployment types. Only the "publish" phase differs: S3 upload for STATIC, Kaniko+ECR push for DYNAMIC.

---

## File reference

| File | Role |
|------|------|
| `apps/build-engine/script.js` | Main orchestrator (213 lines) |
| `apps/build-engine/clone-repo.js` | Git operations + credential management (168 lines) |
| `apps/build-engine/redis.js` | Redis PubSub helper (33 lines) |
| `apps/build-engine/Dockerfile` | Container image definition (8 lines) |
| `apps/build-engine/main.sh` | Shell entry point → `exec node script.js` (2 lines) |
| `apps/api-server/src/deployments/deployment-engine.ts` | ECS task launcher + Lambda deployer (398 lines) |
| `apps/api-server/src/deployments/deployment.service.ts` | Deployment orchestration + status transitions (581 lines) |
| `apps/api-server/src/realtime/log-relay.ts` | Redis → Socket.IO relay (57 lines) |
| `apps/api-server/src/realtime/realtime.types.ts` | PubSub message type definitions (41 lines) |
