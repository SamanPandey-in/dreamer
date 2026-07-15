import { RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { ecsClient } from '../lib/ecs-client';
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
}

export interface EngineHandle {
  ecsTaskArn: string;
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
}

export const deploymentEngine: DeploymentEngine = new EcsDeploymentEngine();
