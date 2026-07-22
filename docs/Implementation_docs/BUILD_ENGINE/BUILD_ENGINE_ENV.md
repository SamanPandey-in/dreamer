# How user environment variables reach the build container

This doc traces the path of user-configured project env vars (the ones set in the dashboard under Project > Environment Variables) from the database all the way into the ECS Fargate build task, where they're available during `npm install` / `npm run build`.

It's written so you can reconstruct the data flow just by reading the file names, not the full source — but I've included the line numbers for when you do need to look.

---

## The path, step by step

### 1. `resolveProjectEnvVarsForEnvironment` — `deployment.service.ts:124`

When `createDeploymentInternal` (or the rollback path) starts a deployment, the first thing it does is resolve the project's env vars for this specific environment (`PRODUCTION` or `PREVIEW`):

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

It reads every `EnvVariable` row belonging to this project whose `environments` array includes the target environment, then decrypts the stored ciphertext using the IV that was saved alongside it. The result is an `Array<{ name: string; value: string }>` — plaintext key-value pairs, ready to send.

Why resolve here instead of inside `deployment-engine.ts`? Keeping `EcsDeploymentEngine` free of Prisma and crypto was an explicit design choice. It takes a `BuildJob` and talks to ECS — that's it. Swapping in a different engine (local Docker, a mock for tests) shouldn't require bringing along a database connection or an encryption key.

### 2. Passed into `launchBuildTask` — `deployment.service.ts:239`

```ts
const handle = await deploymentEngine.launchBuildTask({
  deploymentId: deployment.id,
  projectSlug: project.slug,
  repoUrl: project.repoUrl,
  branch,
  userEnvVars,   // <-- the decrypted array from step 1
  ...
});
```

Nothing special here — it's just one more field on the `BuildJob` interface.

### 3. Spread into ECS container overrides — `deployment-engine.ts:201`

This is where the env vars actually leave the API server and get handed to AWS. The `RunTaskCommand`'s `overrides.containerOverrides[0].environment` array gets the platform vars first (AWS creds, REDIS_URL, DEPLOYMENT_ID, etc.), then the user's vars are spread in last:

```ts
environment: [
  { name: 'AWS_ACCESS_KEY_ID', value: env.AWS_ACCESS_KEY_ID },
  { name: 'REDIS_URL', value: env.REDIS_URL },
  { name: 'DEPLOYMENT_ID', value: job.deploymentId },
  { name: 'PROJECT_SLUG', value: job.projectSlug },
  // ... more platform vars ...
  ...job.userEnvVars.map((v) => ({ name: v.name, value: v.value })),
],
```

ECS container overrides set OS-level environment variables inside the running container. They're not files, not secrets manager references — just plain `KEY=VALUE` pairs in the task's environment, the same as if you ran `docker run -e FOO=bar ...`.

A detail that matters: user vars are spread *last* so that a collision with a reserved prefix (like `DREAMER_` or `AWS_`) is structurally impossible to reach this point — the `RESERVED_ENV_KEY_PREFIXES` validation in `env-variables.types.ts` catches it at creation time, not here.

### 4. The build container inherits them automatically — `script.js:47`

The build engine (`apps/build-engine/script.js`) doesn't have any code that says "read the user env vars and do something with them." It doesn't need to.

When ECS starts the Fargate task using the image built from `apps/build-engine/Dockerfile`, the container override env vars from step 3 become real OS environment variables. Node.js exposes them through `process.env` automatically:

```js
// script.js never does this — it's just how Node works
const FOO = process.env.FOO  // available automatically
```

When `runShellCommand` spawns the build process:

```js
function runShellCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const p = exec(command, { cwd })
    // ...
  })
}
```

`child_process.exec` with no explicit `env` option means the child inherits the parent's full `process.env` — including every user env var. So when `npm run build` runs, any variable the project owner configured in the dashboard is available as an environment variable inside the build script, the same as a `.env` file would be in local development.

### 5. Bonus: Dynamic deployments also get them at runtime — `deployment-engine.ts:261`

For DYNAMIC deployments (Next.js SSR etc.), the same `userEnvVars` array is also set on the Lambda function's `Environment.Variables` inside `deployDynamicApp`:

```ts
const environmentVariables: Record<string, string> = {
  PORT: '3000',
  HOSTNAME: '0.0.0.0',
  AWS_LWA_INVOKE_MODE: 'response_stream',
  NODE_ENV: 'production',
  ...Object.fromEntries(job.userEnvVars.map((v) => [v.name, v.value])),
};
```

This is the **runtime** Lambda — the running app that answers HTTP requests — not the build task. Same env vars, different destination. The build task gets them via ECS container overrides (step 3); the runtime Lambda gets them via `UpdateFunctionConfigurationCommand` / `CreateFunctionCommand`. Both are sourced from the same `resolveProjectEnvVarsForEnvironment` call.

---

## Summary

| Step | File | Line | What happens |
|------|------|------|-------------|
| Read + decrypt | `deployment.service.ts` | 124–136 | Queries `EnvVariable` table, decrypts values |
| Pass to engine | `deployment.service.ts` | 239 | `userEnvVars` field on `BuildJob` |
| ECS overrides | `deployment-engine.ts` | 201 | Spread into `RunTaskCommand` container environment |
| Available in build | `script.js` (build-engine) | 47–73 | Inherited by child `exec()` — no explicit read needed |
| Lambda runtime (dynamic only) | `deployment-engine.ts` | 266 | Also set on the deployed Lambda function |

The key takeaway: user env vars flow from the database to the build container through the ECS container override API. The build engine never explicitly reads them — they're just OS environment variables, inherited naturally by every child process.
