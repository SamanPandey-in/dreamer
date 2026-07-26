# How I built it: SSR / DYNAMIC app support for Dreamer

This is a step-by-step account of adding Next.js SSR (and, more generally,
"dynamic" - server-rendered / server-processing) app support to Dreamer,
written so you can reverse-engineer the approach and rebuild the reasoning
later, not just read a diff.

If you only read one section, I'd suggest to read **Part 1**. Everything after it is
"how", Part 1 is "why", and the "why" is the part that transfers to the
next problem you'll hit that isn't in this doc.

---

## Part 0 - Where this started

Before this change, Dreamer could only do one thing: take a repo, run a
build command, and upload the output folder to S3. `reverse-proxy` proxied
every hostname straight to an S3 path. That's correct for a Vite/CRA/plain-
HTML site - there's no server, just files. But it's fundamentally wrong for a
Next.js app using SSR (`getServerSideProps`, Server Components, API
routes) - there is no "output folder" to upload, because the app needs a
**running process** to answer every request, not a static file to hand
back.

`framework-presets.ts` already knew this - `nextjs-ssr` was flagged
`deploymentType: 'DYNAMIC'` and `requiresUnsupportedRuntime: true` from
the start. That flag was informational only. Nothing acted on it. A user
deploying a Next.js SSR project got a build that "succeeded" and produced
a broken site.

## Part 1 - The research that decided the architecture

The instinct going in was "add an ECS Service behind an ALB" - a
persistent container, load-balanced, the same pattern Railway/Render use.
The schema even had columns for it already (`ecsServiceArn`,
`albTargetGroupArn`, `albListenerRuleArn`) from an earlier design plan.

Before writing any code, I researched how Vercel - the thing this project
is explicitly modeled on (as of now) - actually solves this.

**Finding:** Vercel's SSR path is not a persistent container. It's edge
routing → **AWS Lambda invoke** → response. Vercel's own engineering blog
confirms their serverless architecture is built on AWS Lambda. There's no
ECS, no ALB, no `desiredCount` anywhere in it. The one hard problem they
had to solve - Lambda doesn't natively support HTTP response streaming,
which SSR/RSC streaming needs - they solved with a custom bridge; AWS has
since shipped this natively (Lambda **response streaming** via Function
URLs), which meant the hard part Vercel had to build from scratch, this
project gets from AWS directly.

**Vercel's own blog post on this**: [Fluid: How we built serverless servers](https://vercel.com/blog/fluid-how-we-built-serverless-servers) - 28 Jul 2025

**Why this changed the plan for this phase:** ECS+ALB would get me a *Railway* clone 
(which is not in scope as of now). Lambda would get me a *Vercel* clone
and deletes an entire subsystem (idle-detector, wake-proxy, sleep/wake state machine) for SSR
that ECS+ALB would have required building by hand, because Lambda scales
to zero for free, as a primitive, not as a feature I'd design.

**The tradeoff:** cold starts. A Lambda container image cold start is 200ms–1.5s. 
That's the real cost of not paying for an idle container 24/7. 
Vercel's own users experience this too - it's not a compromise unique to this implementation.

---

## Part 2 - The architecture, end to end

```
Deploy flow (unchanged clone/checkout, NEW branch inside it):

build-engine (still ONE Fargate RunTask, same as STATIC)
  clone -> checkout -> commit info          [unchanged]
        |
        +-- STATIC  --> npm install, npm build, verify output dir,
        |                upload to S3, publish RUNNING           [unchanged]
        |
        +-- DYNAMIC --> resolve Dockerfile (repo's own, or a generated
                         Next.js-on-Lambda template)
                      --> Kaniko build (install+build happens INSIDE
                         the image now, not on the host)
                      --> push to ECR
                      --> publish `image_ready`                    [NEW]


api-server, triggered by `image_ready` via Redis pub/sub -> log-relay.ts:

  handleImageReady()
    -> transition to STARTING
    -> deploymentEngine.deployDynamicApp()
         CreateFunction or UpdateFunctionCode  (PackageType: Image)
         wait until State: Active
         CreateFunctionUrlConfig (InvokeMode: RESPONSE_STREAM) [first deploy only]
         AddPermission (public invoke)                          [first deploy only]
    -> persist lambdaFunctionArn / lambdaFunctionName / lambdaFunctionUrl
    -> transition to RUNNING, url = https://{slug}.{BASE_DOMAIN}


Request flow (unchanged entry point, NEW branch inside it):

  *.singularitydev.xyz -> reverse-proxy
    resolveRoute(subdomain)   [NEW - Postgres lookup, Redis-cached 30s]
      STATIC  -> proxy to S3 path                     [unchanged]
      DYNAMIC -> proxy to deployment's Lambda Function URL,
                 Host header REWRITTEN to match it     [NEW]
```

Two design choices worth keeping in mind, because they're the
"why" behind file-level decisions later in this doc:

1. **One Lambda function per PROJECT, not per deployment.** A redeploy
   calls `UpdateFunctionCode` on the *same* function rather than creating
   a new one - this is exactly the same "latest deploy wins, one live
   slot per project" model STATIC already uses (one shared S3 prefix keyed
   by project slug, not by deployment id). Keeping both types symmetric
   here is what let `stopDeployment()` stay one function with a type
   branch instead of forking into two very different code paths. (Following SRP and OCP)

2. **`api-server`, not `build-engine`, creates the Lambda function.**
   `build-engine`'s IAM role only ever needed S3 + ECR push permissions.
   Giving it Lambda create/update permissions too would mean a compromised
   or buggy build task could create/overwrite Lambda functions; a much
   bigger blast radius than "can push a Docker image." The hand-off
   happens at exactly the point where the image lands in ECR
   (`image_ready`), and everything after that runs under api-server's own,
   separately-scoped IAM identity.

---

## Part 3 - Step by step, in the order it was actually built

### Step 1 - Schema: three new columns

`prisma/schema.prisma` - added `lambdaFunctionArn`, `lambdaFunctionName`,
`lambdaFunctionUrl` to `Deployment`. Left `ecsServiceArn`,
`ecsTaskDefArn`, `albTargetGroupArn`, `albListenerRuleArn` in place,
commented `UNUSED`, rather than dropping them.

**Why not drop them:** dropping a column is a one-way migration. Nothing
was reading these columns (as for now),
so leaving them costs nothing, and it preserves the historical record of
"an ALB-per-deployment design was considered and superseded" for anyone
reading the schema later, maybe six months from now, wondering
why those columns exist.

Migration: `prisma/migrations/20260716120000_add_lambda_dynamic_runtime/migration.sql`
- a plain `ALTER TABLE ADD COLUMN` plus one index on `lambdaFunctionName`
(the column `stopDeployment()` and `deployDynamicApp()` both look up by).

### Step 2 - `env.ts`: new config, all optional

Added `ECR_REPOSITORY_URI`, `LAMBDA_EXECUTION_ROLE_ARN`,
`LAMBDA_ARCHITECTURE` - all `.optional()`/defaulted, matching how
`ECS_CLUSTER_ARN` etc. are already optional. A setup that never deploys a
DYNAMIC project shouldn't be forced to configure Lambda just to boot.

### Step 3 - `lib/lambda-client.ts`: new file

One `LambdaClient`, constructed once, module-scoped - the exact same
pattern `lib/ecs-client.ts` and `lib/s3-client.ts` already use. No new
pattern introduced; consistency was the goal here, not cleverness.

### Step 4 - `deployment-engine.ts`: the actual Lambda logic

This is the file that does the real work. Three things happen here:

**a) `BuildJob` gained `deploymentType` and `framework`.** These get
forwarded into the build task's container environment as `DEPLOYMENT_TYPE`
and `FRAMEWORK` - the ONLY signal `build-engine`'s `script.js` uses to
decide which pipeline to run. Everything downstream (Dockerfile selection,
Kaniko vs. S3) traces back to these two env vars.

**b) `DeploymentEngine` interface gained `deployDynamicApp()` and
`stopDynamicApp()`.** TypeScript now refuses to compile if
`EcsDeploymentEngine` doesn't implement both - that's the actual
enforcement mechanism for "don't forget to wire this up," not a comment.

**c) The implementation.** Walk through it once, because the ordering
matters and isn't obvious from a first read:

1. `GetFunctionCommand` - does this project already have a function? This
   is how a **redeploy** is distinguished from a **first deploy**.
2. First deploy → `CreateFunctionCommand` with `PackageType: 'Image'`.
   Redeploy → `UpdateFunctionCodeCommand` on the same function, THEN
   `UpdateFunctionConfigurationCommand` for env vars - these have to be
   two separate calls with a wait between them, because Lambda rejects a
   second update while `LastUpdateStatus` is still `InProgress`
   (`waitUntilFunctionUpdatedV2` between them is not optional - I hit this
   exact error path in my reasoning and built the wait in from the start
   rather than as an afterthought).
3. `waitUntilFunctionActiveV2` - a fresh function isn't invokable
   immediately; it goes `Pending -> Active` while AWS validates the image.
   Waiting here (rather than returning early) is what lets
   `handleImageReady()` transition straight to `RUNNING` on success,
   instead of needing its own separate polling loop.
4. `GetFunctionUrlConfigCommand`, falling back to
   `CreateFunctionUrlConfigCommand` only if it doesn't exist yet - a
   Function URL, once created, keeps the same hostname across redeploys.
   Recreating it every time would mean the deployment's public URL
   changes on every push, which would break anyone who'd bookmarked it or
   linked to it.
5. `AddPermissionCommand` - the one non-obvious step. A Function URL with
   `AuthType: 'NONE'` still 403s every request until you explicitly add a
   resource policy statement granting `lambda:InvokeFunctionUrl` to `*`.
   This is easy to miss because `AuthType: 'NONE'` *sounds* like "no auth
   needed," but it only controls whether IAM SigV4 signing is required -
   the invoke permission itself is separate. Only done once (guarded by
   the same "does the URL config already exist" check), with a
   `ResourceConflictException` swallowed in case a previous, partially-
   failed deploy attempt already added it.

**d) `stopDynamicApp()`** - delete the Function URL config, then delete
the function. Both wrapped so `ResourceNotFoundException` is swallowed,
not surfaced - same idempotency discipline `stopBuildTask()` already had
for `StopTaskCommand`. A user double-clicking "Stop," or a stop request
landing after AWS already reaped something, shouldn't be a 500.

### Step 5 - `realtime.types.ts` + `log-relay.ts`: the `image_ready` event

Added a fourth event shape (`log`, `status`, `commit_info` were the
existing three) to the `DeploymentEvent` union, and a branch in
`log-relay.ts` that routes it to a new `handleImageReady()` in
`deployment.service.ts`.

**Why a distinct event, not folded into `status`:** `image_ready` carries
data (`ecrImageUri`, the future public `url`) that a plain status
transition doesn't have columns for touching in the same way, and - more
importantly - the *handler* for it does fundamentally different work
(calls out to AWS Lambda APIs, can take 10–60 seconds) than every other
event this channel carries. Keeping it a distinct, explicitly-typed event
is what let TypeScript's exhaustiveness checking catch me if I forgot to
handle it anywhere `DeploymentEvent` is switched on.

### Step 6 - `deployment.service.ts`: `handleImageReady()`

This is the hand-off function. Three things worth understanding about it,
beyond just reading the code:

**Why it re-resolves `userEnvVars` instead of reusing what
`createDeploymentInternal` already resolved:** this function runs minutes
later, triggered by a completely separate async hop (Redis pub/sub, after
`build-engine`'s own process has already exited). There's no in-memory
value left to reuse - it has to hit the DB again, the same as
`launchBuildTask` itself does.

**Why it writes `ecrImageUri` to the row BEFORE attempting the Lambda
deploy, not after:** if `deployDynamicApp()` throws, I still want the
DB to show which image was actually built - for debugging, and so a
retried deploy or a human looking at the dashboard isn't staring at a
blank column wondering if the build even produced anything.

**A known, accepted gap:** while `handleImageReady()` is
mid-flight (status `STARTING`, Lambda function being created), a user
clicking "Stop" hits `stopDeployment()`'s `IN_FLIGHT_BUILD_STATUSES`
branch, which calls `stopBuildTask()` on the build task's ECS ARN - but
that task has *already exited* by this point (its job ended the moment
Kaniko pushed the image). The Stop click doesn't actually cancel the
in-flight `deployDynamicApp()` call. This is a real race condition, not
fixed in this pass - the correct fix is a cancellation token or a DB-level
"stop requested" flag `handleImageReady` checks between AWS calls, and
it's a reasonable next thing to build, not something I want to claim is
solved when it isn't.

### Step 7 - `stopDeployment()`: real teardown instead of a hard block

Before: any `DYNAMIC` deployment hit an immediate `400
DYNAMIC_STOP_UNSUPPORTED` - an honest placeholder for a feature that
didn't exist yet. Replaced with an actual branch: `DYNAMIC` → `Lambda`
teardown via `deploymentEngine.stopDynamicApp()`, `STATIC` → the existing
S3 cleanup, both sharing the same `activeDeploymentId` reset and the same
"only touch it if this row is the project's CURRENT active deployment"
guard that was already there for STATIC.

### Step 8 - `build-engine`: the Kaniko/Dockerfile side

Three new files, one Dockerfile change, one `script.js` restructure.

**Why Kaniko, not `docker build`:** `build-engine` runs as an ECS
**Fargate** task. Fargate gives us no Docker daemon and no privileged
containers - full stop. `docker build`/`docker run` are not available
inside it, at all, regardless of how the code is written. Kaniko builds
an OCI image layer-by-layer in user space, with no daemon, and pushes
straight to a registry - it drops into the exact same "one Fargate
RunTask per build" model the STATIC path already used, instead of
needing a second AWS service (CodeBuild) to hand the image-build step off
to.

**`Dockerfile` (build-engine's own image)** - one line added:
```dockerfile
COPY --from=gcr.io/kaniko-project/executor:debug /kaniko/executor /kaniko/executor
```
The `:debug` tag (not the distroless default) matters - `main.sh` is a
bash script that shells out to the kaniko binary as a subprocess, which
needs a shell to exist in the image at all.

**`dockerfile-templates/nextjs-lambda.dockerfile`** - a two-stage
Dockerfile: `builder` runs the project's own install+build commands,
`runner` is the actual Lambda image - just the Lambda Web Adapter binary
copied to `/opt/extensions/`, plus Next.js's `output: 'standalone'` build
artifacts. This is the officially documented AWS pattern (verified against
`aws/aws-lambda-web-adapter`'s own example repo), not something invented
for this project - the adapter is what lets an *unmodified* Next.js
`server.js` run on Lambda with zero application code changes.

**`dockerfile-resolver.js`** - decides which Dockerfile Kaniko builds:
the repo's own, if it has one at its root (same "config wins over
convention" precedent as `Project.buildCommand` overriding the default),
otherwise a generated one from the template above. Also does a best-effort
text-search check for `output: 'standalone'` in the repo's
`next.config.js` and **warns** (doesn't block) if it's missing - a real
JS/TS parse would be more reliable but isn't worth shipping a parser into
this image for one boolean; the actual failure this check is trying to
catch still surfaces later, just later, as a much less friendly Docker
`COPY` error.

**`kaniko-build.js`** - spawns the kaniko executor with `--dockerfile`,
`--context=dir://...`, `--destination=...`, streams its stdout/stderr into
the same log pipe every other build step already uses. ECR auth: Kaniko
picks up `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` the
exact same way the AWS SDK already does for this task's S3 uploads - no
separate credential-helper step needed.

**`script.js` restructure** - the STATIC install→build→upload sequence
got extracted into `runStaticBuild()` unchanged, and a new
`runDynamicBuild()` was added, with the branch happening **before** step 1
(install), not after. This is the one place I changed my own first
instinct mid-build: my first draft branched AFTER the host-side
install/build, but that meant running `npm install && npm run build`
*twice* - once directly on the host, once again inside Kaniko's own
`builder` stage - for every DYNAMIC deploy. Branching before step 1 means
the two paths only share the clone/checkout/commit-info preamble; DYNAMIC
does its entire install+build exclusively inside the Docker image.

`runDynamicBuild()` deliberately does **not** call `publishStatus`
at all - it only publishes `image_ready` (via
`publishImageReady()`, added to `redis.js`). Ownership boundary: this
task's job is "build and push," full stop; "start" is a distinct phase
owned entirely by `api-server`'s `handleImageReady()`. This also sidesteps
a real bug I caught before it shipped: the DB's own
`check_deployment_status_transition` trigger does **not** allow a
`STARTING -> STARTING` self-transition (only `STARTING -> {RUNNING,
FAILED, STOPPED}`) - if `script.js` had set `STARTING` itself AND
`handleImageReady()` also set `STARTING`, the second call would throw a
Postgres exception. Not double-setting it was the fix; verifying the
trigger's actual allowed-transitions table (in
`20260626105722_extend_stop_transitions/migration.sql`) before writing
either side is what caught this.

### Step 9 - `reverse-proxy`: from a blind string interpolation to a real lookup

This was the file with the literal `// TODO: replace with real DB lookup`
comment - the lowest-risk, most-anticipated change in the whole feature.

**`deployment-lookup.js`** - a `pg.Pool` (not Prisma - this service
handles every single request to every deployed app; pulling in the full
Prisma client/query-engine for one read-only query is a heavier dependency
than this needs) with a 30-second Redis cache in front of it. Without the
cache, every request to every app would cost a Postgres round trip before
it could even start proxying - a tax the old code never paid, because it
never talked to the DB at all.

**`index.js`** - the single `app.use` handler now does: resolve the
route, then branch:
- No route found → `404` (previously: proxy to S3 anyway and let S3 itself
  404 - it "worked," but only by accident, since there was no way to tell
  "wrong subdomain" apart from "right subdomain, deployment not live yet").
- `STATIC` → unchanged S3 proxy behavior.
- `DYNAMIC` → proxy to `route.lambdaFunctionUrl`, with
  **`changeOrigin: true`** - this is the opposite of what I'd assumed
  going in from the ALB design (which would have needed `changeOrigin:
  false` to preserve the original Host header for ALB's own host-based
  routing rules). A Lambda Function URL is its own dedicated hostname per
  function, not a shared front door - the outbound Host header has to be
  rewritten to match it, or AWS's own edge rejects the request before it
  reaches the function at all.

The `proxyReq` handler's S3-specific `/` → `/index.html` rewrite is now
scoped to `STATIC` only (via a `req.dreamerRouteType` flag set before
`proxy.web()` is called) - applying it to a DYNAMIC request would corrupt
the path before it ever reaches Next.js's own router.

---

## Part 4 - What YOU need to do to actually run this

### AWS resources (one-time, by hand - same as how the existing ECS setup was provisioned; no IaC in this repo yet)

1. **ECR repository** - e.g. `dreamer-dynamic-apps`. Enable scan-on-push.
2. **IAM: a Lambda execution role** - trust policy allowing
   `lambda.amazonaws.com` to assume it, with the AWS-managed
   `AWSLambdaBasicExecutionRole` policy attached (CloudWatch Logs only -
   this project has no way to know what other AWS services a user's own
   app code might need, so nothing beyond logging is granted by default).
   → `LAMBDA_EXECUTION_ROLE_ARN`.
3. **IAM: extend `build-engine`'s existing task role** - add
   `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`,
   `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`,
   `ecr:CompleteLayerUpload`, scoped to the one ECR repo's ARN.
4. **IAM: extend `api-server`'s own AWS identity** - add
   `lambda:GetFunction`, `lambda:CreateFunction`,
   `lambda:UpdateFunctionCode`, `lambda:UpdateFunctionConfiguration`,
   `lambda:DeleteFunction`, `lambda:GetFunctionUrlConfig`,
   `lambda:CreateFunctionUrlConfig`, `lambda:DeleteFunctionUrlConfig`,
   `lambda:AddPermission`, `lambda:GetWaiterState` (used internally by the
   `waitUntilFunctionActiveV2`/`waitUntilFunctionUpdatedV2` waiters, via
   `lambda:GetFunction`/`GetFunctionConfiguration` under the hood - the
   full waiter permission set is `lambda:GetFunction`).

### Env vars

- `api-server`: `ECR_REPOSITORY_URI`, `LAMBDA_EXECUTION_ROLE_ARN`,
  `LAMBDA_ARCHITECTURE` (see `.env.example`).
- `build-engine`: nothing new to set by hand - `DEPLOYMENT_TYPE`,
  `FRAMEWORK`, `ECR_REPOSITORY_URI` are all injected per-task by
  `deployment-engine.ts`, same as every other build-time env var.
- `reverse-proxy`: `DATABASE_URL`, `REDIS_URL` (see `.env.example`) - this
  service had zero DB dependency before; it needs real connection strings
  now.

## Part 5 - What's deliberately NOT in this pass, and why

- **Express/Fastify/Hono templates.** The `Framework` enum and
  `dockerfile-resolver.js`'s template map both have room for them
  (`FRAMEWORK_TEMPLATES`), but only `NEXT_SSR` has an actual template.
  Adding one is a genuinely small follow-up: write a
  `dockerfile-templates/node-lambda.dockerfile` (no multi-stage
  build needed - no static-asset split the way Next.js has), add one
  entry to `FRAMEWORK_TEMPLATES`, done. I scoped this out because the
  problem statement was specifically "Next.js SSR failing," and adding
  untested templates for frameworks nobody asked about would have been
  scope creep dressed up as completeness.
- **Scale-to-zero.** Lambda already gives you this for free - there's no
  idle-detector/wake-proxy subsystem to build the way the original
  ECS+ALB plan would have needed. `SLEEPING`/`WAKING` remain valid enum
  values but are now vestigial for the DYNAMIC path specifically.
- **The Stop-during-STARTING race** described in Step 6 - a real,
  acknowledged gap, not silently swept under the rug; will try to solve in next phase.
- **Blue/green on redeploy.** `UpdateFunctionCode` on the live function
  means there's a brief window (the update + `waitUntilFunctionUpdatedV2`)
  where the function is mid-update. Lambda's own behavior here is
  reasonably graceful (in-flight invokes on the old code generally
  complete; new invokes wait briefly rather than erroring), but this
  wasn't specifically load-tested.
