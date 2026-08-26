# Dynamic (SSR) Deployments, From Scratch

Static deployments (see [that doc](./static-deployments.md)) work for
anything that's just files. They fundamentally can't work for a
framework doing server-side rendering — `getServerSideProps`, React
Server Components, API routes — because there's no fixed set of files to
upload; every request needs a **running process** to answer it.

This doc covers the runtime built for that case, from the moment
`build-engine` branches into the DYNAMIC path through to a live, public
URL.

## The model: one container per project

Every project has at most one live app container at a time, named
`dreamer-app-{project.slug}` — a redeploy replaces that same container
rather than accumulating one per deployment, same "latest deploy wins"
rule STATIC's shared output prefix already follows. This is a real
always-on process, not a scale-to-zero function — there's no idle
detector or sleep/wake state machine, because there's exactly one
Docker daemon involved (the VPS's own) and no per-invocation billing
model to optimize around. If you need to reclaim resources from an
idle project, that's a manual `docker stop`, not a platform feature.

## The build: a plain `docker build`, on the same daemon that will run it

`build-engine` runs as a regular container with the host's Docker socket
mounted in (`docker-compose.yml`) — a real Docker daemon is right there,
so `docker build` and `docker run` are just... available. No daemonless
builder, no registry push, no pull-back-down: the image built here
already lives on the exact same daemon `deployDynamicApp()` will
`docker run` it from a moment later.

## The build, step by step

`build-engine`'s `runDynamicBuild()` — note this branches **before**
step 1 of the STATIC pipeline, not after. This is worth understanding
precisely: the generated Dockerfile runs its own `npm install`/`npm run
build` INSIDE the image build (see below) — running them a second time
on the host first would mean paying for the install+build twice, for no
benefit.

```
1. Resolve a Dockerfile — the repo's own, if it has one at its root
   ("config wins over convention," same precedent as every other
   build-command override in this system); otherwise, a generated one
   from a framework-specific template.
2. Warn (not block) if a Next.js repo's next.config.js is missing
   `output: 'standalone'` — see below for why this is required.
3. Run `docker build`, tagged `dreamer-app:{project.slug}` — same
   "tagged by PROJECT, a redeploy overwrites the tag" model as
   everything else in this system.
4. Publish `image_ready` (NOT a status transition — see below) with the
   local image tag and the app's future public URL.
```

### The generated Dockerfile (Next.js)

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY . .
RUN npm install    # the project's own INSTALL_COMMAND
RUN npm run build  # the project's own BUILD_COMMAND

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
```

**`output: 'standalone'`** in the target repo's `next.config.js` is the
one thing that makes this work. Without it, there's no self-contained
`.next/standalone/server.js` to copy — the `COPY --from=builder
/app/.next/standalone ./` step fails outright, with a clear (if slightly
delayed) error. The alternative — copying the builder's entire `/app`
including full `node_modules` — would work but balloon the final image
size for no reason; `standalone` output exists specifically to produce a
minimal, self-contained server that can run as a plain `node server.js`
process with nothing extra attached to it — no adapter, no runtime
harness, just a normal container.

### Why `image_ready`, not a status transition

`build-engine`'s job ends the moment the image exists locally — it does
**not** transition the deployment to `STARTING` itself, only publishes a
distinct `image_ready` event. Turning that built image into an actual
running container happens in `api-server`, not here, so that a
compromised or buggy build container's blast radius stays "can build one
local image," never "can start/stop arbitrary containers on this host."

## The handoff: `api-server`'s `handleImageReady()`

Triggered by `log-relay.ts` when the `image_ready` event arrives (see
[deployments overview](./overview.md#realtime-logs-how-a-builds-output-reaches-your-browser-live)
for the general pub/sub → relay path). This function does the actual
container swap:

```
1. Persist the built image tag to the Deployment row FIRST — independent
   of whether the container swap that follows succeeds. If step 3
   throws, the database still shows exactly which image was built.
2. Transition to STARTING.
3. deploymentEngine.deployDynamicApp():
     a. `docker run` the new image under a THROWAWAY name
        (dreamer-app-{slug}-staging-{timestamp}) — not the canonical
        name yet.
     b. Poll it with a plain HTTP GET until it answers, or time out.
        If it never comes up: remove the staging container, abort the
        deploy, and leave whatever was previously running (if anything)
        completely untouched — a broken build should never take down a
        working deployment.
     c. Only once confirmed healthy: remove whatever was running under
        the CANONICAL name (dreamer-app-{slug}), then `docker rename`
        the staging container into that name. The gap between these two
        calls is a couple of `docker` CLI round-trips, not a full
        container boot — that's the actual downtime a redeploy causes.
4. Persist appContainerId/appContainerName/appUrl.
5. Transition to RUNNING, with the public url from the image_ready event.
```

### A real bug this design already avoided: self-transitioning status

Worth calling out because it's a genuine trap for anyone extending this
system: the Postgres trigger that enforces `Deployment.status`
transitions (see [deployments overview](./overview.md#the-status-state-machine))
does **not** allow `STARTING → STARTING`. If `build-engine` set
`STARTING` itself (it doesn't — see above, it only ever publishes
`image_ready`) AND `handleImageReady()` also set `STARTING`, the second
call would throw a database exception. This is the actual reason
`build-engine`'s dynamic path never touches deployment status at all —
"starting" is entirely `api-server`'s phase to own, not a boundary that
happened to work out by coincidence.

## Serving: how `reverse-proxy` reaches an app container

See [reverse-proxy docs](../reverse-proxy/README.md) for the full
picture. The DYNAMIC-specific piece:

```js
proxy.web(req, res, { target: route.appUrl, changeOrigin: true });
```

`route.appUrl` is `http://dreamer-app-{slug}:3000` — container-to-
container DNS on the `dreamer-local` Docker network both `reverse-proxy`
and the app container sit on. No host port is ever published for an app
container; only `nginx` publishes anything to the outside world (see
`docker-compose.yml`).

## Stopping / teardown

`stopDynamicApp()` is a single `docker rm -f` on the app container's
name — idempotent by construction: removing a container that's already
gone is treated as success, not an error, so a user double-clicking Stop
or a stop request landing after the container was already replaced by a
redeploy never produces a 500.

## What's intentionally not built (yet)

- **Only Next.js has a Dockerfile template.** The `Framework` enum and
  the template-selection map both have room for Express/Fastify/Hono,
  but only `NEXT_SSR` has an actual template wired up today.
- **Nuxt/Vue's dynamic runtime isn't implemented** — `nuxt` is still
  flagged `requiresUnsupportedRuntime: true` in the preset table (see
  [framework-detection docs](../framework-detection/README.md#the-preset-table)).
- **A Stop click during the `STARTING` window doesn't actually cancel
  the in-flight container swap** — the build container's id (which
  `stopDeployment()` targets for any in-flight status) has already
  exited by that point; the real fix would be a cancellation flag
  `handleImageReady()` checks between Docker calls, not built yet.
