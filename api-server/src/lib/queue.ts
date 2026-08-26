import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from './env';
import { createResilientRedisClient } from './redis';
import type { BuildJob } from '../deployments/deployment-engine';

/**
 * CHANGED — every BullMQ Queue/Worker connection now points at
 * REDIS_BUILDER_URL, a Redis instance dedicated to BullMQ only, instead of
 * sharing REDIS_URL with everything else (route cache, metrics counters,
 * pub/sub, Streams — see lib/redis.ts and realtime/log-relay.ts). This is
 * an isolation/scaling decision, not a correctness one: BullMQ is by far
 * the busiest and most latency-sensitive Redis consumer in this codebase
 * (every deploy blocks on it, workers hold blocking BRPOPLPUSH-style
 * connections open continuously) — a noisy neighbor on a shared instance
 * (a burst of metrics writes, a big pub/sub fanout) can no longer add
 * latency to a build enqueue/dequeue, and BullMQ's own Redis memory usage
 * (job data, retry state) can be capacity-planned and scaled completely
 * independently of the other workloads.
 *
 * Falls back to REDIS_URL when REDIS_BUILDER_URL isn't set (see env.ts's
 * own comment on that field) — a single-Redis deployment keeps working
 * unchanged; pointing REDIS_BUILDER_URL at its own instance is what
 * actually splits the two.
 *
 * BullMQ also requires a connection with maxRetriesPerRequest: null (and
 * prefers enableReadyCheck: false) — a constraint the general-purpose
 * `redis` export in lib/redis.ts intentionally doesn't set, which is a
 * second, independent reason every BullMQ Queue/Worker needs its own
 * connection here rather than reusing lib/redis.ts's, on top of now also
 * pointing at a different host entirely. Routed through
 * createResilientRedisClient (lib/redis.ts) for the same reason every raw
 * Redis client in this codebase now is: an unhandled 'error' event on a
 * bare `new Redis(...)` crashes the WHOLE process, build worker included
 * — see that function's own comment for the full story, and
 * src/index.ts's comment for the actual incident that motivated it.
 */
export function createQueueConnection(): Redis {
  return createResilientRedisClient('bullmq', env.REDIS_BUILDER_URL ?? env.REDIS_URL, {
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
 * DB write succeeds) from "get Docker to actually run it" (slow, can be
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
