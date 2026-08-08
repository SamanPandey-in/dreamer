import { RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import {
  AddPermissionCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionCommand,
  DeleteFunctionUrlConfigCommand,
  GetFunctionCommand,
  GetFunctionUrlConfigCommand,
  ResourceConflictException,
  ResourceNotFoundException,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';
import { ecsClient } from '../lib/ecs-client';
import { lambdaClient } from '../lib/lambda-client';
import { env } from '../lib/env';

/**
 * Everything deployment.service.ts needs from "whatever actually runs the
 * build" — Dependency Inversion: the high-level module depends on this
 * abstraction; the AWS SDK detail depends on it too, by implementing it.
 *
 * `stopBuildTask` is the method this file's own original comment said would
 * get added here "when that work starts" — it has, in Part 2 of the polish
 * guide. TypeScript now refuses to compile until every implementer (today,
 * just EcsDeploymentEngine) satisfies the new shape — that compiler error is
 * the actual enforcement mechanism, not just a comment promising you won't
 * forget a second implementation.
 */
export interface DeploymentEngine {
  launchBuildTask(job: BuildJob): Promise<EngineHandle>;

  /**
   * Stops an in-flight build task. ECS's StopTask is idempotent — calling it
   * on a task that already exited does not throw, it just no-ops — which is
   * exactly the semantics stopDeployment() in deployment.service.ts wants:
   * it's allowed to call this speculatively without first re-checking ECS's
   * live state.
   */
  stopBuildTask(ecsTaskArn: string): Promise<void>;

  /**
   *  NEW. Takes a DYNAMIC deployment's already-pushed container image (see
   * build-engine's kaniko-build.js) and turns it into a live, publicly
   * invokable Lambda function with a Function URL. Called from
   * deployment.service.ts's handleImageReady() — the handler for the
   * `image_ready` event build-engine publishes once Kaniko finishes pushing
   * to ECR (see realtime.types.ts).
   *
   * Idempotent by design at the "one function per PROJECT" level: if
   * job.projectSlug already has a function (a redeploy), this updates that
   * SAME function's code instead of creating a second one — see the
   * GetFunctionCommand check inside the implementation. This mirrors how
   * STATIC deployments already share one S3 prefix per project rather than
   * accumulating one per deployment.
   */
  deployDynamicApp(job: DynamicDeployJob): Promise<EngineDynamicHandle>;

  /**
   *  NEW. Tears down a DYNAMIC deployment's Lambda function and its Function
   * URL. Like stopBuildTask, this is written to be safely callable even if
   * the function is already gone (a redeploy may have already deleted-and-
   * recreated it under a race, or a user double-clicks Stop) — AWS's own
   * ResourceNotFoundException is caught and swallowed, not surfaced as a
   * failure to the caller.
   */
  stopDynamicApp(lambdaFunctionName: string): Promise<void>;
}

export interface BuildJob {
  deploymentId: string;
  projectSlug: string;
  projectId: string;
  repoUrl: string;
  branch: string;
  /**  NEW — set only by rollbackDeployment. Pins the build to this exact commit instead of the branch's current HEAD; see clone-repo.js's runCheckoutIfPinned. */
  commitHash?: string;
  gitAccessToken?: string;
  // NEW — resolved build config from the Project row (see project.service.ts
  // and build-config/). null on any field means "build-engine should fall
  // back to its own default" — see script.js's INSTALL_COMMAND/BUILD_COMMAND/
  // OUTPUT_DIRECTORY fallbacks, which exist specifically so a project created
  // before this feature shipped (every column null) keeps building exactly
  // as it did before, with zero migration needed on the Project table itself.
  rootDirectory: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  /**
   * NEW — decrypted project env vars scoped to this deployment's environment
   * (PRODUCTION or PREVIEW), resolved by deployment.service.ts right before
   * calling launchBuildTask. Forwarded into the ECS task's own environment
   * array below, available to the build/runtime exactly like a `.env` file
   * would be on a normal local build.
   */
  userEnvVars: Array<{ name: string; value: string }>;
  /**
   * NEW — forwarded to build-engine as the DEPLOYMENT_TYPE container env
   * var. This is the ONLY thing that decides whether script.js takes the S3
   * branch or the Kaniko/ECR branch after the build finishes — see
   * script.js's `if (DEPLOYMENT_TYPE === 'DYNAMIC')`. Comes straight off
   * Project.detectedDeploymentType, same as the `type` field
   * createDeploymentInternal already copies onto the Deployment row itself.
   */
  deploymentType: 'STATIC' | 'DYNAMIC' | null;
  /**
   *  NEW — forwarded as FRAMEWORK. Used by build-engine's
   * dockerfile-resolver.js to pick the right Dockerfile template
   * (NEXT_SSR → the Next.js standalone + Lambda Web Adapter template; see
   * dockerfile-templates/).
   */
  framework: string | null;
}

export interface EngineHandle {
  ecsTaskArn: string;
}

/**  NEW. What deployDynamicApp needs to build/update a Lambda function. */
export interface DynamicDeployJob {
  deploymentId: string;
  /** Project slug, NOT deployment slug — see lambdaFunctionName's comment on why the function is keyed per-project. */
  projectSlug: string;
  /** The image Kaniko just pushed, e.g. "<account>.dkr.ecr.<region>.amazonaws.com/dreamer-dynamic-apps:my-project". */
  ecrImageUri: string;
  userEnvVars: Array<{ name: string; value: string }>;
}

/**  NEW. What deployDynamicApp hands back for deployment.service.ts to persist on the Deployment row. */
export interface EngineDynamicHandle {
  lambdaFunctionArn: string;
  lambdaFunctionName: string;
  lambdaFunctionUrl: string;
}

export class EcsDeploymentEngine implements DeploymentEngine {
  async launchBuildTask(job: BuildJob): Promise<EngineHandle> {
    const command = new RunTaskCommand({
      cluster: env.ECS_CLUSTER_ARN,
      taskDefinition: env.ECS_TASK_DEFINITION_ARN,
      launchType: 'FARGATE',
      count: 1,
      startedBy: 'api-server',
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'ENABLED',
          subnets: [env.ECS_SUBNET1_ARN, env.ECS_SUBNET2_ARN, env.ECS_SUBNET3_ARN].filter(
            (subnet): subnet is string => Boolean(subnet)
          ),
          securityGroups: env.ECS_SECURITY_GROUP_ARN ? [env.ECS_SECURITY_GROUP_ARN] : [],
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: env.TASK_DEFINITION_IMAGE_NAME,
            environment: [
              { name: 'AWS_ACCESS_KEY_ID', value: env.AWS_ACCESS_KEY_ID ?? '' },
              { name: 'AWS_SECRET_ACCESS_KEY', value: env.AWS_SECRET_ACCESS_KEY ?? '' },
              { name: 'AWS_REGION', value: env.AWS_REGION ?? '' },
              { name: 'REDIS_URL', value: env.REDIS_URL },
              { name: 'GIT_REPOSITORY_URL', value: job.repoUrl },
              { name: 'BRANCH', value: job.branch },
              { name: 'DEPLOYMENT_ID', value: job.deploymentId },
              { name: 'PROJECT_SLUG', value: job.projectSlug },
              //  NEW — conditional, same reasoning as GIT_ACCESS_TOKEN below:
              // an ordinary deploy never sends this at all, so clone-repo.js's
              // runCheckoutIfPinned() is a no-op for every build except a rollback.
              ...(job.commitHash ? [{ name: 'COMMIT_HASH', value: job.commitHash }] : []),
              ...(job.gitAccessToken ? [{ name: 'GIT_ACCESS_TOKEN', value: job.gitAccessToken }] : []),
              // NEW — resolved build config. Always sent (never conditional)
              // so build-engine's own env var fallback (`process.env.X || 'default'`)
              // is the single source of truth for "what happens when a
              // project has no config set" — sending an empty string here
              // and `||`-ing it away in script.js is simpler to reason about
              // than two different layers each independently deciding what
              // the default should be.
              { name: 'ROOT_DIRECTORY', value: job.rootDirectory ?? '' },
              { name: 'INSTALL_COMMAND', value: job.installCommand ?? '' },
              { name: 'BUILD_COMMAND', value: job.buildCommand ?? '' },
              { name: 'OUTPUT_DIRECTORY', value: job.outputDirectory ?? '' },
              // NEW — decides which branch of script.js's `init()` runs
              // after the build finishes: S3 upload (STATIC, unchanged) or
              // Dockerfile-resolve + Kaniko build + ECR push (DYNAMIC, new).
              { name: 'DEPLOYMENT_TYPE', value: job.deploymentType ?? 'STATIC' },
              { name: 'FRAMEWORK', value: job.framework ?? '' },
              // NEW — only meaningful for DYNAMIC builds, but always sent
              // (same "let the receiving side default an empty string"
              // discipline as ROOT_DIRECTORY etc. above) — a STATIC build's
              // script.js branch never reads it.
              { name: 'ECR_REPOSITORY_URI', value: env.ECR_REPOSITORY_URI ?? '' },
              // NEW — the project's own env vars for this deployment's
              // environment, decrypted by deployment.service.ts immediately
              // before this call. Spread last so a reserved-prefix collision
              // is structurally impossible to reach this point at all — see
              // env-variables.types.ts's RESERVED_ENV_KEY_PREFIXES, enforced
              // at creation time, not here.
              ...job.userEnvVars.map((v) => ({ name: v.name, value: v.value })),
            ],
          },
        ],
      },
    });

    const result = await ecsClient.send(command);
    const taskArn = result.tasks?.[0]?.taskArn;

    if (!taskArn) {
      const reason = result.failures?.[0]?.reason ?? 'ECS RunTask returned no task ARN';
      throw new Error(`Failed to launch build task: ${reason}`);
    }

    return { ecsTaskArn: taskArn };
  }

  /**  NEW */
  async stopBuildTask(ecsTaskArn: string): Promise<void> {
    await ecsClient.send(
      new StopTaskCommand({
        cluster: env.ECS_CLUSTER_ARN,
        task: ecsTaskArn,
        reason: 'Stopped by user via Dreamer dashboard',
      })
    );
  }

  /**
   *  NEW. Lambda function names must be 1–64 chars of [a-zA-Z0-9-_] — a
   * project slug from random-word-slugs (e.g. "fuzzy-cat-42") already
   * satisfies that with room to spare, so no sanitizing beyond the prefix
   * is needed. Exported as its own function (not inlined) because
   * stopDeployment() in deployment.service.ts needs to derive the SAME name
   * from a project slug when a Deployment row predates this column being
   * populated — see that file's stopDeployment for the fallback.
   */
  private lambdaFunctionNameFor(projectSlug: string): string {
    return `dreamer-${projectSlug}`;
  }

  /**  NEW */
  async deployDynamicApp(job: DynamicDeployJob): Promise<EngineDynamicHandle> {
    const functionName = this.lambdaFunctionNameFor(job.projectSlug);

    // Lambda's own environment variables, PLUS the project's user-configured
    // ones. PORT=3000 matches Next.js standalone server.js's own default
    // AND the Dockerfile template's `ENV PORT=3000` (see
    // dockerfile-templates/nextjs-lambda.dockerfile) — the Lambda Web
    // Adapter reads PORT itself as a fallback for AWS_LWA_PORT (per its own
    // docs), so setting it once, consistently, in both places is enough;
    // no separate AWS_LWA_PORT override needed. AWS_LWA_INVOKE_MODE must
    // match the Function URL's own InvokeMode (RESPONSE_STREAM) set below
    // in CreateFunctionUrlConfigCommand — mismatched, this silently falls
    // back to buffering the whole response before sending it, which breaks
    // Next.js's streaming SSR / React Server Components output. Spreading
    // userEnvVars LAST for the same reserved-prefix-collision reasoning as
    // launchBuildTask above — RESERVED_ENV_KEY_PREFIXES already made a
    // collision with a platform-reserved key impossible at creation time.
    const environmentVariables: Record<string, string> = {
      PORT: '3000',
      HOSTNAME: '0.0.0.0',
      AWS_LWA_INVOKE_MODE: 'response_stream',
      NODE_ENV: 'production',
      ...Object.fromEntries(job.userEnvVars.map((v) => [v.name, v.value])),
    };

    // Does this project already have a function? A redeploy updates the
    // SAME function's code (UpdateFunctionCode) rather than creating a
    // second one — one Lambda function per PROJECT, exactly like STATIC's
    // one S3 prefix per project. GetFunctionCommand throws
    // ResourceNotFoundException on a fresh project's first-ever DYNAMIC
    // deploy; that's the expected, common case for CreateFunctionCommand
    // below, not an error to propagate.
    let functionExists = true;
    try {
      await lambdaClient.send(new GetFunctionCommand({ FunctionName: functionName }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        functionExists = false;
      } else {
        throw err;
      }
    }

    let functionArn: string;

    if (functionExists) {
      const updateResult = await lambdaClient.send(
        new UpdateFunctionCodeCommand({ FunctionName: functionName, ImageUri: job.ecrImageUri })
      );
      functionArn = updateResult.FunctionArn ?? `arn:aws:lambda:${env.AWS_REGION}:function:${functionName}`;
      // A code update needs its own settling time before the NEXT update
      // (including env-var changes below) is accepted — Lambda rejects a
      // second UpdateFunctionCode/Configuration call while
      // LastUpdateStatus is still "InProgress" with a ResourceConflictException.
      await waitUntilFunctionUpdatedV2(
        { client: lambdaClient, maxWaitTime: 120 },
        { FunctionName: functionName }
      );
      await lambdaClient.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: functionName,
          Environment: { Variables: environmentVariables },
        })
      );
      await waitUntilFunctionUpdatedV2(
        { client: lambdaClient, maxWaitTime: 120 },
        { FunctionName: functionName }
      );
    } else {
      const createResult = await lambdaClient.send(
        new CreateFunctionCommand({
          FunctionName: functionName,
          PackageType: 'Image',
          Code: { ImageUri: job.ecrImageUri },
          Role: env.LAMBDA_EXECUTION_ROLE_ARN,
          Timeout: 30,
          MemorySize: 1024,
          Architectures: [env.LAMBDA_ARCHITECTURE],
          Environment: { Variables: environmentVariables },
        })
      );
      functionArn = createResult.FunctionArn ?? `arn:aws:lambda:${env.AWS_REGION}:function:${functionName}`;
    }

    // Newly created (or just-updated) functions aren't necessarily
    // immediately invokable — State goes Pending -> Active during image
    // validation. Waiting here (rather than optimistically returning) is
    // what lets deployment.service.ts transition straight to RUNNING on
    // success instead of needing its own separate polling loop.
    await waitUntilFunctionActiveV2({ client: lambdaClient, maxWaitTime: 120 }, { FunctionName: functionName });

    // Function URL config: created once per function, reused across
    // redeploys (its own URL never changes when the function's CODE
    // changes — only CreateFunction/UpdateFunctionCode touch that). Look
    // it up first; only create if this is truly the first deploy.
    let functionUrl: string;
    try {
      const existingUrlConfig = await lambdaClient.send(
        new GetFunctionUrlConfigCommand({ FunctionName: functionName })
      );
      functionUrl = existingUrlConfig.FunctionUrl!;
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;

      const urlConfig = await lambdaClient.send(
        new CreateFunctionUrlConfigCommand({
          FunctionName: functionName,
          AuthType: 'NONE',
          InvokeMode: 'RESPONSE_STREAM',
        })
      );
      functionUrl = urlConfig.FunctionUrl!;
    }

    // FIXED — this used to live INSIDE the `catch` block above, i.e. it
    // only ever ran the very first time a function's Function URL config
    // was created. That's wrong: a function can end up with a URL config
    // but NO invoke permission — e.g. a deploy that got this far and then
    // failed on a LATER step (so the whole deployDynamicApp() call threw
    // and was retried), or a function that was created/inspected manually
    // outside this platform while testing. Either way, the next deploy
    // would take the `try` branch above (GetFunctionUrlConfigCommand
    // succeeds), skip this block entirely, and produce exactly the
    // symptom this was debugged from: a 200 from Lambda's own console, a
    // live Function URL, and a 403 Forbidden on every actual request.
    // Running this on EVERY deploy — not just function creation — is what
    // makes deployDynamicApp() actually idempotent with respect to "is
    // this function reachable," not just "does it exist." A
    // ResourceConflictException here just means a previous deploy already
    // added this exact statement — not an error, the desired end state.
    //
    // FIXED (round 2) — a public Function URL actually needs TWO resource
    // policy statements, not one: `lambda:InvokeFunctionUrl` (the HTTP
    // entry point itself) AND plain `lambda:InvokeFunction` (the
    // underlying invoke permission the Function URL service calls on your
    // behalf). Confirmed against the Lambda console's own diagnostic
    // banner: "Your function URL auth type is NONE, but is missing
    // permissions required for public access... create a resource-based
    // policy that grants lambda:invokeFunction AND lambda:invokeFunctionUrl
    // permissions." AddPermission only accepts ONE Action per call — there
    // is no way to grant both in a single statement — so this is two
    // separate calls with two separate StatementIds, not one call with a
    // list.
    const publicInvokePermissions: Array<{ statementId: string; action: string }> = [
      { statementId: 'PublicFunctionUrlInvoke', action: 'lambda:InvokeFunctionUrl' },
      { statementId: 'PublicInvokeFunction', action: 'lambda:InvokeFunction' },
    ];

    for (const { statementId, action } of publicInvokePermissions) {
      const permissionInput: Parameters<typeof AddPermissionCommand>[0] = {
        FunctionName: functionName,
        StatementId: statementId,
        Action: action,
        Principal: '*',
      };

      if (action === 'lambda:InvokeFunctionUrl') {
        // AWS only accepts FunctionUrlAuthType on the Function URL action.
        permissionInput.FunctionUrlAuthType = 'NONE';
      }

      try {
        await lambdaClient.send(
          new AddPermissionCommand(permissionInput)
        );
      } catch (permErr) {
        if (!(permErr instanceof ResourceConflictException)) throw permErr;
      }
    }

    return { lambdaFunctionArn: functionArn, lambdaFunctionName: functionName, lambdaFunctionUrl: functionUrl };
  }

  /**  NEW */
  async stopDynamicApp(lambdaFunctionName: string): Promise<void> {
    try {
      await lambdaClient.send(new DeleteFunctionUrlConfigCommand({ FunctionName: lambdaFunctionName }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }

    try {
      await lambdaClient.send(new DeleteFunctionCommand({ FunctionName: lambdaFunctionName }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }
  }
}

export const deploymentEngine: DeploymentEngine = new EcsDeploymentEngine();
