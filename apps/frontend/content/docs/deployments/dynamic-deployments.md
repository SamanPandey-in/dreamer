# Dynamic (SSR) Deployments, From Scratch

Static deployments (see [that doc](./static-deployments.md)) work for
anything that's just files. They fundamentally can't work for a
framework doing server-side rendering — `getServerSideProps`, React
Server Components, API routes — because there's no fixed set of files to
upload; every request needs a **running process** to answer it.

This doc covers the runtime built for that case, from the moment
`build-engine` branches into the DYNAMIC path through to a live, public
URL.

## The model: one Lambda function per project, not a persistent container

The design this settled on mirrors how Vercel itself actually works —
edge routing to a serverless function invocation, not a persistent
container behind a load balancer (the more common Railway/Render
pattern, and the one this system's schema was originally scaffolded for
before this runtime existed — see `schema.prisma`'s comments on the
now-unused `ecsServiceArn`/`albTargetGroupArn` columns). Confirmed
directly from Vercel's own engineering writing: their serverless
architecture is built on AWS Lambda under the hood.

This choice has one concrete, load-bearing consequence worth
understanding before anything else: **Lambda scales to zero for free, as
a platform primitive.** An idle-detector, a wake-proxy, a sleep/wake
state machine — all of that would be required infrastructure under an
always-on-container model, and none of it exists here, because Lambda
doesn't invoke (or charge) anything when nothing is requesting it.

## Why the build itself can't just `docker build`

`build-engine` runs as an ECS **Fargate** task. Fargate gives you no
Docker daemon and no privileged containers, at all — `docker build` and
`docker run` are simply not options inside it, regardless of how the
code around them is written.

**Kaniko** (an open-source, daemonless image builder) is the answer:
it builds an OCI image layer-by-layer entirely in user space, with no
daemon involved, and pushes straight to a registry. This is why the
build-engine Docker image itself has one extra line compared to before
this runtime existed:

```dockerfile
COPY --from=gcr.io/kaniko-project/executor:debug /kaniko/executor /kaniko/executor
```

One binary, copied in at build time — Kaniko drops into the exact same
"one Fargate `RunTask` per build" model the STATIC path already used,
rather than requiring a second AWS service (like CodeBuild, which
natively supports privileged builds) to hand the image-build step off to.

## The build, step by step

`build-engine`'s `runDynamicBuild()` — note this branches **before**
step 1 of the STATIC pipeline, not after. This is worth understanding
precisely because the first version of this actually branched later, and
that was a real bug caught during development: the generated Dockerfile
runs its own `npm install`/`npm run build` INSIDE the image build (see
below) — running them a second time on the host first would mean paying
for the install+build twice, for no benefit.

```
1. Resolve a Dockerfile — the repo's own, if it has one at its root
   ("config wins over convention," same precedent as every other
   build-command override in this system); otherwise, a generated one
   from a framework-specific template.
2. Warn (not block) if a Next.js repo's next.config.js is missing
   `output: 'standalone'` — see below for why this is required.
3. Run Kaniko: build the resolved Dockerfile, push the resulting image
   to ECR, tagged `{repo}:{project.slug}` — same "tagged by PROJECT, a
   redeploy overwrites the tag" model as everything else in this system.
4. Publish `image_ready` (NOT a status transition — see below) with the
   pushed image URI and the app's future public URL.
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

COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 /lambda-adapter /opt/extensions/lambda-adapter

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
```

Two things make this work, and both are load-bearing:

**`output: 'standalone'`** in the target repo's `next.config.js`. Without
it, there's no self-contained `.next/standalone/server.js` to copy — the
`COPY --from=builder /app/.next/standalone ./` step fails outright, with
a clear (if slightly delayed) error. The alternative — copying the
builder's entire `/app` including full `node_modules` — would work but
balloon the final image size for no reason; `standalone` output exists
specifically to produce a minimal, self-contained server.

**The Lambda Web Adapter** (`aws-lambda-adapter`), copied to
`/opt/extensions/`. This is the entire integration between "a normal
Node HTTP server" and "something Lambda can invoke" — Lambda's own
container runtime auto-discovers and loads anything in
`/opt/extensions/` as a Lambda Extension on cold start, before the app
process (`node server.js`) even starts. Nothing about the Next.js app
itself needs to know it's running on Lambda; the adapter is what
translates Lambda's invoke event into a normal HTTP request against
`localhost:3000` (matching `PORT`), and streams the response back out.
Works with a plain `node:22-slim` base image — no dependency on one of
AWS's own pre-built Lambda base images.

### Why `image_ready`, not a status transition

`build-engine`'s job ends the moment the image lands in ECR — it does
**not** transition the deployment to `STARTING` itself, only publishes a
distinct `image_ready` event. Turning that pushed image into an actual
running Lambda function needs the AWS Lambda API, which needs IAM
permissions build-engine's task role deliberately does not have — its
role only ever needed S3 (STATIC) and ECR push (DYNAMIC) permissions.
Widening that role to include `lambda:CreateFunction` would mean a
compromised or buggy build task could create or overwrite Lambda
functions directly — a materially larger blast radius than "can push one
image to one registry."

## The handoff: `api-server`'s `handleImageReady()`

Triggered by `log-relay.ts` when the `image_ready` event arrives (see
[deployments overview](./overview.md#realtime-logs-how-a-builds-output-reaches-your-browser-live)
for the general pub/sub → relay path). This function does the actual
Lambda provisioning, under `api-server`'s own, separately-scoped AWS
credentials:

```
1. Persist the pushed image URI to the Deployment row FIRST — independent
   of whether the Lambda deploy that follows succeeds. If step 3 throws,
   the database still shows exactly which image was built.
2. Transition to STARTING.
3. deploymentEngine.deployDynamicApp():
     a. GetFunction — does this PROJECT already have a Lambda function?
        (one function per project, keyed dreamer-{project.slug} — same
        "redeploy overwrites the same thing" rule as everywhere else)
     b. First deploy  → CreateFunction (PackageType: Image)
        Redeploy      → UpdateFunctionCode, then (after waiting for that
                         update to finish — Lambda rejects a second
                         update call while one is still in progress)
                         UpdateFunctionConfiguration for env vars
     c. Wait for the function to report State: Active
     d. Get-or-create a Function URL (InvokeMode: RESPONSE_STREAM — see
        below), reusing the SAME url across redeploys, never recreating it
     e. Grant public invoke permission — see the two-statement gotcha below
4. Persist lambdaFunctionArn/Name/Url.
5. Transition to RUNNING, with the public url from the image_ready event.
```

### Response streaming

`AuthType: 'NONE'` + `InvokeMode: 'RESPONSE_STREAM'` on the Function URL,
and `AWS_LWA_INVOKE_MODE=response_stream` set as one of the function's
environment variables (matching the adapter's own expected config) — this
is what lets a Next.js app's streaming SSR / React Server Components
output actually stream to the browser, rather than Lambda buffering the
entire response before sending anything. This is also the one piece
Vercel had to build custom infrastructure for before AWS shipped it
natively as a Function URL feature — this platform gets it for free by
being built after that feature existed.

### The two-statement public-access gotcha

A public (unauthenticated) Function URL needs **two** separate
resource-policy statements, not one — `lambda:InvokeFunctionUrl` (the
HTTP entry point itself) **and** plain `lambda:InvokeFunction` (the
underlying invoke permission the Function URL service calls on your
behalf internally). `AddPermission` only accepts one `Action` per call,
so this is genuinely two separate API calls with two separate
`StatementId`s — there's no single call that grants both. Missing the
second one produces a `403 Forbidden` that looks identical to a missing
`AuthType: NONE` setting or an entirely absent policy, despite being a
different, more specific problem — this is documented here specifically
because it's easy to fix the "obvious" half of the policy and still be
stuck.

```ts
const publicInvokePermissions = [
  { statementId: 'PublicFunctionUrlInvoke', action: 'lambda:InvokeFunctionUrl' },
  { statementId: 'PublicInvokeFunction', action: 'lambda:InvokeFunction' },
];

for (const { statementId, action } of publicInvokePermissions) {
  try {
    await lambdaClient.send(new AddPermissionCommand({
      FunctionName: functionName, StatementId: statementId, Action: action,
      Principal: '*', FunctionUrlAuthType: 'NONE',
    }));
  } catch (permErr) {
    if (!(permErr instanceof ResourceConflictException)) throw permErr;
  }
}
```

This runs on **every** deploy, not just the function's first-ever
creation (an earlier version of this code only ran it inside the
"creating the Function URL for the first time" branch — which meant a
function that already had a URL config from a prior partial deploy could
end up permanently missing this grant, since later deploys would skip
straight past it). `ResourceConflictException` is swallowed deliberately
— it just means a previous deploy already added this exact statement,
which is the desired end state, not a failure.

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

## Serving: how `reverse-proxy` reaches a Lambda function

See [reverse-proxy docs](../reverse-proxy/README.md) for the full
picture. The DYNAMIC-specific piece:

```js
proxy.web(req, res, { target: route.lambdaFunctionUrl, changeOrigin: true });
```

`changeOrigin: true` here is the opposite of STATIC's proxy config, and
deliberately so: a Lambda Function URL is its own unique hostname per
function (`xxxx.lambda-url.{region}.on.aws`) — not a shared front door
using host-header routing the way an ALB would be. The outbound `Host`
header has to be rewritten to match that function's own hostname, or
AWS's own edge rejects the request before it ever reaches the function.

## Stopping / teardown

```
DeleteFunctionUrlConfig → DeleteFunction
```
Both wrapped so `ResourceNotFoundException` is swallowed, not surfaced —
same idempotency discipline as `stopBuildTask()`'s ECS `StopTask` call. A
user double-clicking Stop, or a stop request landing after AWS already
reaped something, shouldn't produce a 500.

## What's intentionally not built (yet)

- **Only Next.js has a Dockerfile template.** The `Framework` enum and
  the template-selection map both have room for Express/Fastify/Hono,
  but only `NEXT_SSR` has an actual template wired up today.
- **Nuxt/Vue's dynamic runtime isn't implemented** — `nuxt` is still
  flagged `requiresUnsupportedRuntime: true` in the preset table (see
  [framework-detection docs](../framework-detection/README.md#the-preset-table)).
- **A Stop click during the `STARTING` window doesn't actually cancel
  the in-flight Lambda creation** — the build task's ECS ARN (which
  `stopDeployment()` targets for any in-flight status) has already
  exited by that point; the real fix would be a cancellation flag
  `handleImageReady()` checks between AWS calls, not built yet.
