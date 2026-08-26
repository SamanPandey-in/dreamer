# Dynamic (SSR) Deployments, From Scratch

Static deployments (see [that doc](./static-deployments.md)) work for
anything that's just files. They fundamentally can't work for a
framework doing server-side rendering — server components, API routes,
anything that computes a response per request — because there's no fixed
set of files to upload; every request needs a **running process** to
answer it.

This doc covers the runtime built for that case, from the moment
`build-engine` branches into the DYNAMIC path through to a live, public
URL.

## The model: one long-lived container per project

The design here is the persistent-container model: each DYNAMIC project
gets exactly one Docker container (`dreamer-app-{project.slug}`) that
stays up and serves every request, fronted by `reverse-proxy`. No
registry is involved anywhere — images are built locally and run
locally, by the same Docker daemon, on the same box.

This choice has one concrete consequence worth understanding before
anything else: **a deployed app consumes its resources whether or not
it's receiving traffic.** Every running app container is capped at
`512m` of memory and half a CPU core at launch, so one noisy app can't
starve the box — but capacity planning on a single machine is genuinely
yours to do in a way it isn't under an always-elastic hosted runtime.

## Why the build can use plain `docker build`

The build container mounts the host's Docker socket
(`/var/run/docker.sock`) into `build-engine`, so `runDynamicBuild()` runs
the standard `docker build` against the host daemon directly. That one
mount removes the entire problem space a daemonless build environment
has: no special image builder, no registry push step, no pulling the
image back down to run it. **Build and run share one daemon** — the image
exists on the box the moment the build finishes, ready to `docker run`.

The trade-off is stated plainly: mounting the socket means the build
process can technically drive the host daemon. That's acceptable here
because the build container is already fully isolated from everything
else on the box (its own filesystem, no database credentials, no storage
credentials beyond what the build itself needs), and it exits the moment
the build finishes either way.

## The build, step by step

`build-engine`'s `runDynamicBuild()` — note this branches **before**
step 1 of the STATIC pipeline, not after:

```
1. Resolve a Dockerfile — the repo's own, if it has one at its root
   ("config wins over convention," same precedent as every other
   build-command override in this system); otherwise, a generated one
   from a framework-specific template.
2. Warn (not block) if a Next.js repo's next.config.js is missing
   `output: 'standalone'` — see below for why this matters.
3. Run `docker build`, tagging the result dreamer-app:{project-slug} —
   same "tagged by PROJECT, a redeploy overwrites the tag" model as
   everything else in this system.
4. Publish `image_ready` (NOT a status transition — see below) with the
   local image tag and the app's future public URL.
```

Step 1 happens before any install/build deliberately: a DYNAMIC app's
install+build runs INSIDE the image build (the generated Dockerfile's
own `builder` stage), so doing them again out in the build container
first would pay the bulk of a build's wall-clock time twice for nothing.
The two paths only share the clone/checkout/commit-info preamble.

### The generated Dockerfile (Next.js)

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY . .
RUN __INSTALL_COMMAND__
RUN __BUILD_COMMAND__

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

(`__INSTALL_COMMAND__`/`__BUILD_COMMAND__` are substituted from the
project's detected or overridden build config before the build runs.)

Two things make this work, and both are load-bearing:

**`output: 'standalone'`** in the target repo's `next.config.js`. Without
it, there's no self-contained `.next/standalone/server.js` to copy — the
`COPY --from=builder /app/.next/standalone ./` step fails outright, with
a clear (if slightly delayed) error. The alternative — copying the
builder's entire `/app` including full `node_modules` — would work but
balloon the final image size for no reason; `standalone` output exists
specifically to produce a minimal, self-contained server. This is why
step 2 *warns* rather than silently producing an image that fails ten
minutes later.

**A plain Node server, nothing else.** The runner stage just executes
`node server.js` as an ordinary long-lived process — there's no adapter
layer between "normal HTTP app" and "the thing reverse-proxy talks to,"
because both sides speak plain HTTP on the same network. The container
listens on `PORT=3000` bound to `0.0.0.0` inside the compose network, and
that's the whole contract.

### Why `image_ready`, not a status transition

`build-engine`'s job ends the moment the image exists locally — it does
**not** transition the deployment to `STARTING` itself, only publishes a
distinct `image_ready` event. Turning that image into a live, healthy
container is `api-server`'s phase to own entirely (see below). The
boundary isn't arbitrary: the Postgres trigger enforcing status
transitions rejects `STARTING → STARTING`, so if both sides ever set the
same status the second write throws a database exception. One phase, one
owner — "starting" is `api-server`'s, by design.

## The handoff: `api-server`'s `handleImageReady()`

Triggered by `log-relay.ts` when the `image_ready` event arrives (see
[deployments overview](./overview.md#realtime-logs-how-a-builds-output-reaches-your-browser-live)
for the general pub/sub → relay path). This function turns the pushed
image into a live container via `deploymentEngine.deployDynamicApp()`:

```
1. Persist the built image tag to the Deployment row FIRST — independent
   of whether the container deploy that follows succeeds. If step 3
   throws, the database still shows exactly which image was built.
2. Transition to STARTING.
3. deployDynamicApp():
      a. Start the image as a STAGING container first — named
         dreamer-app-{slug}-staging-{timestamp}, capped at 512m /
         0.5 CPU, with PORT=3000, HOSTNAME=0.0.0.0, NODE_ENV=production,
         plus every resolved user env var.
      b. Wait for it to pass an HTTP health check (an actual request
         against its port, not a Docker status poll).
      c. Only once confirmed healthy: remove whatever currently runs
         under the canonical name dreamer-app-{slug}, rename the staging
         container into its place.
4. Persist the new appContainerName/appUrl (container-to-container DNS:
   http://dreamer-app-{slug}:3000 — no host port published, only nginx
   ever binds a public port).
5. Transition to RUNNING, with the public URL from the image_ready event.
```

### Why a health-checked staged swap, not stop-then-start

The staging-first dance exists specifically so a **redeploy of a broken
build can't take a working site down.** The old container keeps serving
traffic (reverse-proxy's route still resolves to it) for the entire time
the new one boots. If the new container never becomes healthy — crashes
on boot, doesn't bind to `0.0.0.0:3000`, dies on a missing env var — the
staging container is removed, the swap aborts, and the previous
deployment is left untouched. You get a clear failure in the build log
and a still-live site, instead of a working site replaced by a 502. The
only traffic gap in the happy path is the couple of `docker` calls
between removing the old container and renaming the staged one — not a
full boot.

## Serving: how `reverse-proxy` reaches the app container

See [reverse-proxy docs](../reverse-proxy/README.md) for the full
picture. The DYNAMIC-specific piece:

```js
proxy.web(req, res, { target: route.appUrl, changeOrigin: true });
```

Both containers sit on the same private compose network, so this is pure
container-to-container DNS — no published ports, nothing reachable
except through nginx. No path rewriting applies on this branch at all;
the app's own router sees requests exactly as they arrived.

## Stopping / teardown

Stopping a `RUNNING` dynamic deployment removes the app container via
`dockerRemove()` — written to swallow "no such container" rather than
surface it as a failure, so double-clicking Stop, or a stop landing after
a redeploy already swapped the container out, is a clean no-op instead
of a 500. Same discipline as the build-container stop path.

One known gap: clicking Stop during the narrow `STARTING` window doesn't
cancel the in-flight health-check wait — the build container (which the
generic in-flight stop targets) has already exited by that point. See
"What's intentionally not built" below.

## What's intentionally not built (yet)

- **Only Next.js has a Dockerfile template.** The `Framework` enum and
  the template-selection map have room for Express/Fastify/Hono, but
  only `NEXT_SSR` has an actual template wired up today. Anything else
  deploying DYNAMIC must ship its own Dockerfile at the repo root.
- **Nuxt/Vue's dynamic runtime isn't implemented** — `nuxt` is still
  flagged `requiresUnsupportedRuntime: true` in the preset table (see
  [framework-detection docs](../framework-detection/README.md#the-preset-table)),
  so the wizard blocks it rather than producing a deployment that 404s.
- **A Stop click during the `STARTING` window doesn't actually cancel
  the health-check wait** — the real fix would be a cancellation flag
  `handleImageReady()` checks between steps; not built yet.
