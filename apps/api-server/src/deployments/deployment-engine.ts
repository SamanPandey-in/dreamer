import { RunTaskCommand } from '@aws-sdk/client-ecs';
import { ecsClient } from '../lib/ecs-client';
import { env } from '../lib/env';

/**
 * Everything deployment.service.ts needs from "whatever actually runs the
 * build" — and nothing more (Dependency Inversion: the high-level module
 * depends on this abstraction; the low-level AWS SDK detail depends on it
 * too, by implementing it — neither depends on the other directly).
 *
 * This interface is deliberately THIS small. It is not the full
 * sleep/wake/stop/getStatus surface the platform will eventually need for
 * scale-to-zero — adding unimplemented methods now would be speculative
 * complexity (the inverse SOLID failure: an interface so big nothing can
 * honestly implement all of it yet). When that work starts, I'll add
 * `stopBuildTask()` here AND to EcsDeploymentEngine — TypeScript will refuse
 * to compile until every implementer satisfies the new shape, which is the
 * entire enforcement value of coding to an interface in the first place.
 */
export interface DeploymentEngine {
  /**
   * Starts a build for one deployment and returns as soon as the work has
   * been *handed off* — it does not wait for the build to finish. Progress
   * reporting is the realtime gateway's job (Part 4), not this interface's;
   * mixing "start the work" and "report on the work" into one method would
   * violate Single Responsibility for no benefit.
   */
  launchBuildTask(job: BuildJob): Promise<EngineHandle>;
}

export interface BuildJob {
  deploymentId: string;
  deploymentSlug: string;
  projectId: string;
  repoUrl: string;
  branch: string;
  /** Only set for project.isPrivate — decrypted just-in-time, never persisted, never logged. */
  gitAccessToken?: string;
}

export interface EngineHandle {
  /** Provider-specific reference, persisted on Deployment.ecsTaskArn for later lookup. */
  ecsTaskArn: string;
}

/**
 * Fargate implementation. This is the ONLY file in deployments/ that imports
 * an AWS SDK package. Swapping in a `BareMetalEngine` (`docker run` against
 * a local daemon, for local dev without an AWS bill) later is a new class
 * implementing the same interface — deployment.service.ts doesn't change.
 */
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
              // Renamed from the prototype's single PROJECT_ID: the build
              // container now needs BOTH identifiers — the deployment ID
              // keys the Redis channel (so logs/status land on the right
              // row), the slug keys the S3 prefix (so it becomes the
              // subdomain) — see Part 6 for why these can no longer be the
              // same value once one project can have many deployments.
              { name: 'DEPLOYMENT_ID', value: job.deploymentId },
              { name: 'DEPLOYMENT_SLUG', value: job.deploymentSlug },
              ...(job.gitAccessToken ? [{ name: 'GIT_ACCESS_TOKEN', value: job.gitAccessToken }] : []), // Conditional, on purpose — public repos never get handed a live token at all
            ],
          },
        ],
      },
    });

    const result = await ecsClient.send(command);
    const taskArn = result.tasks?.[0]?.taskArn;

    if (!taskArn) {
      // result.failures carries ECS's own reason (no capacity, bad subnet,
      // throttled, ...) — surface it instead of a generic message, so a
      // FAILED deployment in the dashboard is actually debuggable.
      const reason = result.failures?.[0]?.reason ?? 'ECS RunTask returned no task ARN';
      throw new Error(`Failed to launch build task: ${reason}`);
    }

    return { ecsTaskArn: taskArn };
  }
}

/**
 * The one place anything in this codebase decides WHICH engine is active.
 * deployment.service.ts imports this constant, never the class — if a
 * factory based on env.DEPLOYMENT_ENVIRONMENT gets added later (cloud vs.
 * bare-metal, per the multi-engine design in your own docs/Ideation_docs),
 * it changes here and nowhere else.
 */
export const deploymentEngine: DeploymentEngine = new EcsDeploymentEngine();
