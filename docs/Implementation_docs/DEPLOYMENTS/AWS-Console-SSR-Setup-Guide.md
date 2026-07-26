# AWS Console Setup Guide — SSR / DYNAMIC (Lambda) support

This walks through everything to click in the AWS Console to make the code
in branch `SSR` actually work. It assumes your existing STATIC
pipeline is already running (you have a working IAM user, ECS cluster,
S3 bucket, etc.) — this guide only covers what's **new**.

**Read this first, it saves you a step:** your project uses one long-lived
IAM **user's** access key (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in
`api-server`'s env) for *everything* — `api-server`'s own AWS calls, AND
`build-engine`'s S3 uploads (api-server forwards its own keys into the
build task as container overrides — see `deployment-engine.ts` line ~161).
There are no ECS task IAM roles involved anywhere in this project today.
So: **you do not need to touch ECS task roles.** You need to (1) extend
that one existing IAM user's permissions, and (2) create one *new*, separate
IAM role — but that new role is for Lambda **functions** to assume at
runtime, which is a completely different thing from the IAM user your
services authenticate AS. Don't conflate the two; Step 2 and Step 3 below
are deliberately kept apart for this reason.

Also good news: **Lambda Function URLs need no VPC, no security group, no
subnet configuration at all.** Unlike your ECS setup, these Lambda
functions are not attached to your VPC (they don't need to reach anything
inside it), so there's no networking section in this guide.

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
