# AWS Console Setup Guide — Static + Dynamic (SSR) Deployments

This is the complete AWS setup for Dreamer, in the order you'd actually
need it: **Part 1** gets STATIC deployments working — the foundation
everything else sits on top of (the IAM user every service authenticates
as, the S3 bucket, the ECS cluster that runs every build). **Part 2**
adds DYNAMIC (Next.js SSR / Lambda) support on top of that. If you're
starting this project from nothing, do Part 1 first, confirm a static
site actually deploys end to end, then move on to Part 2.

This guide covers AWS resource provisioning only. For actually running
`api-server`/`frontend`/`reverse-proxy` somewhere and pointing your domain
at them, see [`SELF-HOSTING.md`](./SELF-HOSTING.md) — that's a separate
concern from the AWS side covered here, and the two combine (self-hosted
control plane + AWS-hosted build/deploy compute is the normal, expected
setup, not a mismatch).

---

# Part 1 — STATIC deployments

## Prerequisites

- An AWS account.
- A domain with wildcard DNS support (`*.yourdomain.com`) — see
  [`SELF-HOSTING.md`](./SELF-HOSTING.md) for the DNS side once you get
  there; this section only covers the AWS resources themselves.

## Step 1 — Create the IAM user

This is the **one** identity every service in this project authenticates
as — `api-server` uses its access key directly for every AWS API call it
makes, and also **forwards that same key** into every `build-engine`
container it launches (see `deployment-engine.ts`'s `launchBuildTask` —
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are passed as container
overrides). There's no separate ECS task role anywhere in this project —
one user, one set of keys, used everywhere.

1. Console → **IAM** → **Users** → **Create user**.
2. Name it something recognizable, e.g. `dreamer-app`.
3. Don't attach any permissions yet — you'll come back and add a scoped
   policy in Step 7, once the resources it needs to reference actually
   exist.
4. After creating the user: **Security credentials** tab → **Create
   access key** → **Application running outside AWS** → create. Copy
   both the **Access key ID** and **Secret access key** immediately — the
   secret is shown exactly once. These become your `AWS_ACCESS_KEY_ID`
   and `AWS_SECRET_ACCESS_KEY`.

## Step 2 — Create the S3 bucket

This is where every STATIC build's output actually lives.

1. Console → **S3** → **Create bucket**.
2. Setup all env vars: S3_BUCKET=your-bucket-name, AWS_REGION=your-region, BASE_PATH=https://bucket-name.s3.region.amazonaws.com/__outputs
3. **Uncheck "Block all public access"** (all four checkboxes) — every
   deployed static app needs its files publicly readable; there's no
   CloudFront, no signed URLs, no auth in front of this bucket in this
   project's design. Acknowledge the warning.
4. Create the bucket, then go to its **Permissions** tab → **Bucket
   policy** → paste:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "PublicReadForDeployedApps",
         "Effect": "Allow",
         "Principal": "*",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/__outputs/*"
       }
     ]
   }
   ```
   Scoped to the `__outputs/*` prefix specifically — not the whole
   bucket — so only actual deployed-app files are public, not anything
   else you might later store in this same bucket.

## Step 3 — VPC networking for ECS

Every build runs as an ECS Fargate task, which needs at least one subnet
and one security group to launch into.

**Simplest path: use your account's Default VPC** — every AWS account
has one already, with a subnet in every Availability Zone, which is
enough to get started. Console → **VPC** → **Subnets** — copy the
**Subnet ID** (looks like `subnet-0a1b2c3d4e5f6g7h8`) for two or three of
them, from the default VPC.

Then create a security group for the build tasks: **VPC** → **Security
Groups** → **Create security group**, in that same default VPC. No
inbound rules needed (a build task doesn't accept incoming connections —
it clones a repo and pushes output out, it never listens on anything);
leave the default **outbound: allow all** rule, which build tasks need
to reach GitHub, npm's registry, and AWS's own APIs. Copy the **Security
group ID** (`sg-0a1b2c3d4e5f6g7h8`).

**Important naming gotcha, worth reading before you fill in env vars
later:** this project's env vars are named `ECS_SUBNET1_ARN`,
`ECS_SUBNET2_ARN`, `ECS_SUBNET3_ARN`, and `ECS_SECURITY_GROUP_ARN` — but
despite the `_ARN` suffix, AWS's own `RunTask` API does **not** accept
ARNs for `awsvpcConfiguration.subnets`/`securityGroups` — it wants the
plain **IDs** (`subnet-...`, `sg-...`), exactly as copied above. Put the
ID in, not the ARN, regardless of what the variable name suggests — this
is a naming inconsistency in the codebase, not a hint about what format
is expected.

## Step 4 — Create the ECS cluster

1. Console → **ECS** → **Clusters** → **Create cluster**.
2. Name it (e.g. `dreamer-cluster`), infrastructure: **AWS Fargate
   (serverless)** — no EC2 instances to manage.
3. Create. Copy the cluster's **ARN** from its detail page — this is
   your `ECS_CLUSTER_ARN` (the one place in this whole setup where the
   `_ARN`-named variable actually does want a real ARN — `cluster`
   accepts either the ARN or the bare name, so either works, but the ARN
   is unambiguous).

## Step 5 — Push the `build-engine` image somewhere ECS can pull it from

This is a **different** image/repo from anything DYNAMIC-related in
Part 2 — this is the platform's own build-runner image, not a deployed
app's image.

1. Console → **ECR** → **Create repository** → private, name it
   `dreamer-build-engine` (or similar).
2. From `apps/build-engine` locally: copy push commands from AWS console ECR repo dashboard
   ```bash
   aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.ap-south-1.amazonaws.com
   docker build -t dreamer-build-engine .
   docker tag dreamer-build-engine:latest <account-id>.dkr.ecr.ap-south-1.amazonaws.com/dreamer-build-engine:latest
   docker push <account-id>.dkr.ecr.ap-south-1.amazonaws.com/dreamer-build-engine:latest
   ```

## Step 6 — Create the ECS Task Definition

1. Console → **ECS** → **Task definitions** → **Create new task
   definition**.
2. Launch type: **AWS Fargate**. OS/architecture: Linux/X86_64 (or
   ARM64, if you built the image for that — matches whatever your Docker
   build's host architecture was).
3. Task size: 1 vCPU / 3GB memory is a reasonable starting point for a
   typical `npm install && npm run build` — bump this later if you see
   builds getting OOM-killed on larger projects.
4. **Task execution role**: let the console create a new one for you
   (`ecsTaskExecutionRole`) — this only needs permission to pull the
   image and write CloudWatch logs, both of which the default
   `AmazonECSTaskExecutionRolePolicy` already covers. **No task role**
   needed beyond this — build-engine authenticates to AWS via the static
   keys forwarded into its environment (Step 1), not an IAM role.
5. Container details:
   - **Name**: this exact string becomes your `TASK_DEFINITION_IMAGE_NAME`
     env var — `deployment-engine.ts` uses it to target the right
     container when applying overrides, so whatever you type here has to
     match exactly. `build-image` is a reasonable choice.
   - **Image URI**: the ECR image URI from Step 5.
   - Leave port mappings empty — this container never listens on
     anything.
6. Create. Copy the task definition's **ARN** — this is your
   `ECS_TASK_DEFINITION_ARN`.

## Step 7 — Attach a permissions policy to the IAM user from Step 1

Now that the bucket and cluster exist, go back to **IAM** → **Users** →
your user → **Add permissions** → **Create inline policy** → JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StaticOutputBucket",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::dreamer-outputs",
        "arn:aws:s3:::dreamer-outputs/*"
      ]
    },
    {
      "Sid": "RunAndStopBuildTasks",
      "Effect": "Allow",
      "Action": ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks"],
      "Resource": "*"
    },
    {
      "Sid": "PassBuildTaskExecutionRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::YOUR_ACCOUNT_ID:role/ecsTaskExecutionRole"
    }
  ]
}
```

`iam:PassRole` here is the same category of easy-to-miss requirement as
the one in Part 2's IAM setup — `RunTask` passes the task execution role
along with it, and the caller needs explicit permission to hand that
role out, or the call fails with an `AccessDenied` mentioning
`iam:PassRole` specifically.

## Step 8 — Set the environment variables

On `api-server` (`.env`, or wherever you're setting it for your hosting
setup — see [`SELF-HOSTING.md`](./SELF-HOSTING.md)):

```
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=<from Step 1>
AWS_SECRET_ACCESS_KEY=<from Step 1>
S3_BUCKET=dreamer-outputs
ECS_CLUSTER_ARN=<from Step 4>
ECS_TASK_DEFINITION_ARN=<from Step 6>
ECS_SUBNET1_ARN=<subnet ID from Step 3 — an ID, not an ARN, see the gotcha above>
ECS_SUBNET2_ARN=<a second subnet ID>
ECS_SUBNET3_ARN=<a third subnet ID, or repeat one of the above if your default VPC only has two AZs>
ECS_SECURITY_GROUP_ARN=<security group ID from Step 3 — again, an ID>
TASK_DEFINITION_IMAGE_NAME=<the exact container name from Step 6>
```

## Step 9 — Test end to end

1. Deploy `api-server`, `frontend`, and `reverse-proxy` somewhere they
   can reach each other and the internet (see
   [`SELF-HOSTING.md`](./SELF-HOSTING.md) for the one-command path).
2. Point your domain's DNS at wherever `reverse-proxy` is reachable
   (again, covered in the Self-Hosting Guide).
3. In the dashboard, import a plain static repo — a Vite or Create React
   App project is the simplest thing to test with first, before
   attempting anything SSR-related in Part 2.
4. Deploy it. Watch the build logs: clone → install → build → **upload
   to S3** → `RUNNING`.
5. Visit `https://{project-slug}.yourdomain.com` — you should see the
   actual app.
6. Check the S3 console — `dreamer-outputs` → `__outputs/{project-slug}/`
   should have every file the build produced.

Once this works, move on to Part 2 for SSR support.

---

# Part 2 — DYNAMIC (SSR) deployments

Everything below builds on Part 1 — the IAM user, the ECS cluster, and
the `build-engine` task definition all already exist by this point;
this section only adds what SSR support needs on top of that.

**Read this first, it saves you a step:** your project uses that same one
long-lived IAM **user's** access key from Part 1
(`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in `api-server`'s env) for
*everything* — `api-server`'s own AWS calls, AND `build-engine`'s S3/ECR
work (api-server forwards its own keys into the build task as container
overrides — see `deployment-engine.ts`'s `launchBuildTask`). There are no
ECS task IAM roles involved anywhere in this project. So: **you do not
need to touch ECS task roles again here.** You need to (1) extend that
same IAM user's permissions further, and (2) create one *new*, separate
IAM role — but that new role is for Lambda **functions** to assume at
runtime, which is a completely different thing from the IAM user your
services authenticate AS. Don't conflate the two; Step 2 and Step 3 below
are deliberately kept apart for this reason.

Also good news: **Lambda Function URLs need no VPC, no security group, no
subnet configuration at all.** Unlike Part 1's ECS setup, these Lambda
functions are not attached to your VPC (they don't need to reach anything
inside it), so there's no networking section in this half of the guide.

---

## Step 1 — Create the ECR repository

This is where Kaniko pushes every DYNAMIC app's image.

1. Console → **ECR** → **Repositories** → **Create repository**.
2. Visibility: **Private**.
3. Repository name: `dreamer-dynamic-apps`.
4. **Image scan settings** → turn on **Scan on push** (free, catches known
   CVEs in the base image / dependencies).
5. Leave encryption/tag immutability at defaults.
6. Create. Copy the **URI** shown on the repository's page — it looks like
   `123456789012.dkr.ecr.ap-south-1.amazonaws.com/dreamer-dynamic-apps`.
   This is your `ECR_REPOSITORY_URI`.

*(Optional, worth doing later, not blocking:* Repository → **Lifecycle
policy** → add a rule expiring untagged images after 7 days. Every
redeploy pushes a new digest under the same tag; the old digest becomes
untagged and just sits there costing storage until something cleans it
up.)

---

## Step 2 — Create the Lambda execution role

This is the role every **deployed app's Lambda function** assumes when it
runs — separate from your own IAM user.

1. Console → **IAM** → **Roles** → **Create role**.
2. Trusted entity type: **AWS service**.
3. Use case: **Lambda**. Next.
4. Attach permissions policy: search for and check **AWSLambdaBasicExecutionRole**
   (an AWS-managed policy — grants only CloudWatch Logs write access).
   Don't attach anything broader than this — this project has no way to
   know what other AWS services a user's deployed app might try to call,
   so it isn't granted access to anything beyond logging its own output.
5. Role name: `dreamer-lambda-execution-role`. Create.
6. Open the role, copy its **ARN** (top of the page, looks like
   `arn:aws:iam::123456789012:role/dreamer-lambda-execution-role`). This is
   your `LAMBDA_EXECUTION_ROLE_ARN`.

---

## Step 3 — Extend your existing IAM user's permissions

Find the IAM user whose access key is already sitting in your
`api-server` env as `AWS_ACCESS_KEY_ID` (check IAM → Users if you don't
remember the name — it's the one with your existing ECS/S3 policies
attached).

1. Console → **IAM** → **Users** → click that user.
2. **Permissions** tab → **Add permissions** → **Create inline policy**.
3. Switch to the **JSON** editor and paste:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PushToDynamicAppsEcrRepo",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PushToDynamicAppsEcrRepoScoped",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "arn:aws:ecr:YOUR_REGION:YOUR_ACCOUNT_ID:repository/dreamer-dynamic-apps"
    },
    {
      "Sid": "ManageDynamicAppLambdaFunctions",
      "Effect": "Allow",
      "Action": [
        "lambda:GetFunction",
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:GetFunctionUrlConfig",
        "lambda:CreateFunctionUrlConfig",
        "lambda:DeleteFunctionUrlConfig",
        "lambda:AddPermission",
        "lambda:RemovePermission"
      ],
      "Resource": "arn:aws:lambda:YOUR_REGION:YOUR_ACCOUNT_ID:function:dreamer-*"
    },
    {
      "Sid": "PassLambdaExecutionRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::YOUR_ACCOUNT_ID:role/dreamer-lambda-execution-role"
    }
  ]
}
```

Replace `YOUR_REGION` and `YOUR_ACCOUNT_ID` (found top-right of the console,
or via `aws sts get-caller-identity`).

**Two things worth understanding, not just pasting:**
- `dreamer-*` in the Lambda resource ARN matches `lambdaFunctionNameFor()`
  in `deployment-engine.ts` (`dreamer-${projectSlug}`) — scoping the
  policy to this prefix means this IAM user can't touch any *other* Lambda
  function in your account, only ones this platform itself created.
- `iam:PassRole` is easy to forget and produces a confusing error if you
  do: `CreateFunctionCommand` passes `LAMBDA_EXECUTION_ROLE_ARN` as the
  function's execution role, and AWS requires whoever calls
  `CreateFunction` to *also* have explicit permission to "pass" that role
  along — otherwise you could get one IAM identity to hand out a more
  privileged role than it holds itself. Without this statement, function
  creation fails with an `AccessDenied` mentioning `iam:PassRole`
  specifically, which doesn't obviously point back to "add this
  statement" unless you already know to look for it.
4. Name the policy `dreamer-dynamic-app-permissions`. Create.

---

## Step 4 — Set the new environment variables

On wherever `api-server` actually runs (your `.env` file, or your
hosting platform's env var settings):

```
ECR_REPOSITORY_URI=123456789012.dkr.ecr.ap-south-1.amazonaws.com/dreamer-dynamic-apps
LAMBDA_EXECUTION_ROLE_ARN=arn:aws:iam::123456789012:role/dreamer-lambda-execution-role
LAMBDA_ARCHITECTURE=x86_64
```

**Check `LAMBDA_ARCHITECTURE` against your existing setup before assuming
`x86_64` is right:** Kaniko builds the image using whatever CPU
architecture the build-engine Fargate task itself runs on. Open **ECS** →
your cluster → **Task Definitions** → your build-engine task definition →
check **Runtime platform → CPU architecture**. If it says `ARM64`
(Graviton), set `LAMBDA_ARCHITECTURE=arm64` instead — a mismatch here
means Lambda rejects the image at `CreateFunction` with an architecture
error, not a subtle runtime bug, so you'll know immediately if this is
wrong, but better to check now.

`reverse-proxy` (wherever it's hosted — its own box, per your README)
needs, in its own `.env`:
```
DATABASE_URL=<the same Postgres connection string api-server uses>
REDIS_URL=<the same Redis instance build-engine/api-server use>
```
This service had **zero** database dependency before this change — if
it's currently firewalled off from your database (e.g. RDS security group
only allows the VPC), you'll need to open that up, since reverse-proxy
runs outside the VPC per your own README's self-hosting section.

---

## Step 5 — Database migration

From your local machine (or wherever you run migrations), pointed at your
real `DATABASE_URL`:

```bash
cd apps/api-server
npx prisma migrate deploy
npx prisma generate
```

This applies `20260716120000_add_lambda_dynamic_runtime` (adds
`lambdaFunctionArn`/`lambdaFunctionName`/`lambdaFunctionUrl` to
`Deployment`) and regenerates the TypeScript client properly — the copy
shipped in the zip was hand-patched in a sandbox that couldn't reach
Prisma's binary download servers; this command replaces it with the real
thing, safely.

---

## Step 6 — Rebuild and push the `build-engine` image

The Kaniko binary is baked into `build-engine`'s own Docker image at
build time now (`Dockerfile`'s new `COPY --from=gcr.io/kaniko-project/executor:debug`
line). The image your ECS task definition currently references does
**not** have this yet — you need to rebuild and push a new one.

1. From `apps/build-engine`:
   ```bash
   docker build -t build-engine .
   docker tag build-engine:latest <your-existing-build-engine-ecr-repo-uri>:latest
   docker push <your-existing-build-engine-ecr-repo-uri>:latest
   ```
   (This is whatever ECR repo/registry your build-engine task definition
   already points at — not the new `dreamer-dynamic-apps` repo from Step 1,
   which is for *deployed apps'* images, not this platform's own
   build-engine image.)
2. If your ECS task definition pins an image **digest** rather than
   `:latest`, register a new task definition revision pointing at the
   freshly-pushed image, and update your ECS service (if build-engine runs
   as a service) or just let the next `RunTask` call pick up the new
   `:latest` tag (if, like the STATIC path today, it's launched fresh per
   build with no persistent service).

---

## Step 7 — Deploy the updated `api-server` code

Standard deploy for however you already ship `api-server` — the important
part is that it's running the code from this zip (with `npm install` run
to pick up the new `@aws-sdk/client-lambda` dependency) and has the Step 4
env vars set before it starts.

---

## Step 8 — Deploy `reverse-proxy`'s updated code

Same idea — `npm install` (for the new `pg`/`ioredis` dependencies), the
Step 4 env vars set, then restart it.

---

## Step 9 — Test end to end

1. Pick (or create) a small Next.js repo with `output: 'standalone'` set
   in `next.config.js`:
   ```js
   /** @type {import('next').NextConfig} */
   module.exports = { output: 'standalone' }
   ```
   If you don't have one handy, `npx create-next-app@latest` and add that
   one line before pushing it to a repo Dreamer can access.
2. Import it as a new project in Dreamer. The wizard should now detect it
   as **Next.js** with no "unsupported runtime" warning (that flag was
   flipped off in `framework-presets.ts` as part of this change).
3. Deploy. Watch the build logs — you should see, in order: clone →
   commit info → `"No Dockerfile found — generating one from the NEXT_SSR
   template."` → Kaniko's own build/push output → `"Image pushed to
   ECR"` → then a status flip to **STARTING** (this is where api-server is
   calling `CreateFunction` and waiting for it to go Active — expect
   10–30 seconds here) → **RUNNING**.
4. **Verify in the AWS Console while it's building**, to build a mental
   model of what's actually happening: ECR → `dreamer-dynamic-apps` repo →
   you should see a new tag matching your project's slug appear right
   after the "Image pushed to ECR" log line. Lambda → **Functions** → you
   should see `dreamer-{your-project-slug}` appear once STARTING begins.
5. Visit `https://{your-project-slug}.{your-base-domain}` — this request
   goes through `reverse-proxy`'s new DB lookup, resolves to `DYNAMIC`,
   and proxies to the Function URL. You should see your actual Next.js app,
   server-rendered.
6. Try **Stop** on the deployment from the dashboard — confirm in the
   Lambda console that the function and its Function URL are gone
   afterward.
7. Push a small change to the repo and redeploy — confirm (a) the SAME
   Lambda function's code gets updated (not a second function created),
   and (b) the Function URL stays the same as before.

---

## Troubleshooting

**Build fails at "Kaniko exited with code 1", stderr mentions the ECR
push specifically (not the image build itself)** → almost always the IAM
policy in Step 3 — check the `Resource` ARN on the ECR statements matches
your actual repo ARN exactly (region, account ID, repo name).

**Function created successfully, but visiting the URL gives a 403** → the
`AddPermission` call in `deployDynamicApp()` didn't run or was denied.
Check the IAM policy includes `lambda:AddPermission`. You can verify
manually: Lambda console → your function → **Configuration** →
**Permissions** → scroll to **Resource-based policy statements** — you
should see one named `PublicFunctionUrlInvoke`.

**Build fails with a Docker `COPY .next/standalone: not found` error** →
the target repo's `next.config.js` is missing `output: 'standalone'`. You
should also see a WARN-level log line earlier in the build calling this
out before the failure — that's `dockerfile-resolver.js`'s best-effort
check catching it (see the code comments on why that check warns instead
of hard-blocking).

**`CreateFunction` fails with an `AccessDenied` mentioning `iam:PassRole`**
→ see the callout in Step 3 — you're missing the `PassLambdaExecutionRole`
statement.

**`CreateFunction` fails with an architecture/image mismatch error** →
see the `LAMBDA_ARCHITECTURE` callout in Step 4.

**reverse-proxy returns 404 for a deployment you can see is RUNNING in
the dashboard** → check `reverse-proxy` can actually reach your database
(Step 4's networking note) and that its Redis cache isn't serving a stale
cached-miss from before the deployment went live — this self-heals within
30 seconds either way (`CACHE_TTL_SECONDS` in `deployment-lookup.js`), so
if it's been longer than that and still 404ing, it's the DB connection.
