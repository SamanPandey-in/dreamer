import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from './env';
import { createResilientRedisClient } from './redis';
import type { BuildJob } from '../deployments/deployment-engine';

/**
 * Every BullMQ Queue/Worker connection points at REDIS_BUILDER_URL — a Redis
 * instance dedicated to BullMQ — instead of sharing REDIS_URL with route
 * cache, metrics counters, pub/sub, and Streams (see lib/redis.ts,
 * realtime/log-relay.ts). An isolation/scaling decision, not a correctness
 * one: BullMQ is by far the busiest and most latency-sensitive Redis
 * consumer here (every deploy blocks on it, workers hold blocking
 * connections open continuously), so a noisy neighbor on the shared
 * instance can't add latency to build enqueue/dequeue, and BullMQ's memory
 * usage can be capacity-planned independently. Falls back to REDIS_URL when
 * REDIS_BUILDER_URL isn't set.
 *
 * BullMQ also requires maxRetriesPerRequest: null (and prefers
 * enableReadyCheck: false) — options the general-purpose `redis` export in
 * lib/redis.ts intentionally doesn't set, an independent second reason every
 * Queue/Worker builds its own connection here. Routed through
 * createResilientRedisClient like every raw Redis client: an unhandled
 * 'error' event on a bare `new Redis(...)` crashes the whole process (see
 * lib/redis.ts).
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
