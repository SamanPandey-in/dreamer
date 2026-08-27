# Architecture Overview

## The system, end to end

Five services, all running as containers on the same VPS. Two of them
(`frontend`, `api-server`) are the control plane — the dashboard you
interact with. One (`build-engine`) is ephemeral compute that only
exists for the duration of a single build, launched on-demand with
`docker run`. One (`reverse-proxy`) is the always-on ingress every
deployed app's traffic passes through. The last "service" isn't a
service at all — it's whatever a user's own project becomes once
deployed: either files in MinIO or a running Docker container, both
entirely outside Dreamer's own runtime.

## Why a separate build-engine, and why a fresh container per build

Building an arbitrary user's repo means running `npm install` and
`npm run build` for code you didn't write, with a package.json you don't
control, potentially with a malicious `postinstall` script. That's not
something to run inside `api-server`'s own process — a compromised build
should not have access to `api-server`'s database credentials, its
Redis connection, or any other tenant's data.

A fresh `build-engine` container per build is the isolation mechanism:
its own filesystem, its own environment, that exits the moment the build
finishes. `api-server` never runs untrusted code itself — it only ever
`docker run`s an isolated container and waits for that container to
report back over Redis pub/sub.

See [`deployments/overview.md`](../deployments/overview.md) for exactly
what `build-engine` does once it's running.

## Why Postgres + Redis are used for different things

- **Postgres** is the durable source of truth — every `Project`,
  `Deployment`, `User`, `UserSession`, and `DeploymentLog` row lives here.
  Anything that needs to survive a restart, or that another part of the
  system needs to query later, goes here.
- **Redis** is used for two things that are NOT durable state:
  1. **Pub/sub** — `build-engine` publishes log lines and status updates
     to a channel named `deployment:{deploymentId}`; `api-server`
     subscribes and relays them to connected dashboard clients over
     Socket.IO, AND persists them to Postgres as it goes (see
     `realtime/log-relay.ts`). Redis here is a message bus, not storage —
     if no one's subscribed when a message publishes, it's gone; the
     Postgres write is what actually makes the log durable.
  2. **A 30-second cache** in `reverse-proxy`, in front of the Postgres
     query that resolves a subdomain to a deployment (see
     [`reverse-proxy/README.md`](../reverse-proxy/README.md)) — every
     single request to every deployed app would otherwise cost a
     Postgres round trip before it could even start proxying.

## The full lifecycle of one deployment

This is the thread that ties every other doc together. Follow a single
deployment from click to live URL:

1. **User clicks "Deploy"** in the dashboard (or hits `POST
   /api/deployments`). `api-server`'s `deployment.service.ts` creates a
   `Deployment` row with status `QUEUED`, resolves the project's
   configured (or user-overridden) env vars, and calls
   `deploymentEngine.launchBuildTask()`.
2. **`launchBuildTask()`** runs `docker run` on the `build-engine`
   image, with everything that container needs (repo URL, branch,
   install/build commands, `DEPLOYMENT_TYPE`, `FRAMEWORK`, env vars,
   MinIO credentials) passed in as container env vars, and the host
   Docker socket mounted in so a DYNAMIC build can run its own `docker
   build`. The `Deployment` row transitions to `BUILDING`.
3. **Inside the container**, `build-engine`'s `script.js` clones the
   repo, checks out the right commit, and branches on `DEPLOYMENT_TYPE`:
   - **STATIC**: `npm install` → `npm run build` → verify the output
     directory exists → upload every file to MinIO under
     `__outputs/{project-slug}/`.
   - **DYNAMIC**: resolve a Dockerfile (the repo's own, or a generated
     one) → `docker build` it, tagged locally — see
     [`deployments/dynamic-deployments.md`](../deployments/dynamic-deployments.md).
   Every log line and status change is published to Redis as it happens.
4. **`api-server`'s `log-relay.ts`** is subscribed to that Redis channel
   the whole time — it persists each log line to Postgres and relays it
   over Socket.IO to anyone with the deployment's detail page open, live.
5. **STATIC finishes here** — the last thing `build-engine` publishes is
   a `RUNNING` status with the deployment's public URL, and
   `Project.activeDeploymentId` is updated to point at it.
   **DYNAMIC has one more hop**: `build-engine`'s job ends at "image
   built locally" — it publishes an `image_ready` event instead. That
   event triggers `handleImageReady()` back in `api-server`, which
   `docker run`s the new image under a staging name, health-checks it,
   and only then swaps it into place — this happens in `api-server`, not
   `build-engine`, deliberately: the build container's job is done the
   moment the image exists, and a compromised build container should
   never be able to start/stop arbitrary containers on the host. Once
   the swap completes, `api-server` transitions the deployment to
   `RUNNING` itself.
6. **A visitor hits `https://{project-slug}.yourdomain.com`.**
   `reverse-proxy` looks up that subdomain (Postgres, Redis-cached),
   finds the project's `activeDeploymentId`, checks its `type`, and
   proxies accordingly — straight to the MinIO path for STATIC, or to
   the deployment's app container over the shared Docker network for
   DYNAMIC.

Every step above is covered in far more depth in its own doc — this page
is the map, not the territory.

## The state machine

`Deployment.status` isn't a free-form string — a Postgres trigger
(`check_deployment_status_transition`, in the schema's migrations)
enforces which transitions are even possible at the database level, not
just in application code. The full set:

```
QUEUED → BUILDING → UPLOADING* → RUNNING
                  ↘ STARTING†  ↗
                  ↘ FAILED
        (any of the above) → STOPPED
```

\* `UPLOADING` is STATIC-only (the MinIO upload phase).
† `STARTING` is DYNAMIC-only — covers the window between "image built"
and "new container passed its health check."

This matters beyond bookkeeping: it's what makes `stopDeployment()` safe
to call from any state without special-casing every possible current
status in application code — an invalid transition simply gets rejected
by Postgres itself.
