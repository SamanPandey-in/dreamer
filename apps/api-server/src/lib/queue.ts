import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from './env';
import type { BuildJob } from '../deployments/deployment-engine';

/**
 * BullMQ manages its own blocking commands under the hood and requires a
 * connection with maxRetriesPerRequest: null (and prefers enableReadyCheck:
 * false) — the general-purpose `redis` export in lib/redis.ts is shared by
 * ordinary one-shot commands and intentionally doesn't set that, so every
 * BullMQ Queue/Worker gets its own dedicated connection here instead of
 * reusing it. Same reasoning as why realtime/log-relay.ts keeps its pub/sub
 * connection separate from lib/redis.ts.
 */
export function createQueueConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export const BUILD_QUEUE_NAME = 'build-tasks';

/**
 * One job per deployment. deployment.service.ts's createDeploymentInternal
 * enqueues here instead of calling deploymentEngine.launchBuildTask directly
 * — src/workers/build.worker.ts is the only thing that actually calls it.
 * This decouples "accept the deploy request" (fast, always succeeds if the
 * DB write succeeds) from "get ECS to actually run it" (slow, can be
 * rate-limited, retried, and capped in concurrency independently of how many
 * deploy requests land in the same second).
 */
export const buildQueue = new Queue<BuildJob>(BUILD_QUEUE_NAME, {
  connection: createQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    // Bounded history instead of unbounded growth — BullMQ jobs live in
    // Redis, not Postgres, so old completed/failed jobs are just cache, not
    // the source of truth (the Deployment row already is).
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1_000 },
  },
});
