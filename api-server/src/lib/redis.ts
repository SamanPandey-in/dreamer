import Redis, { type RedisOptions } from 'ioredis';
import { env } from './env';
import { logger } from './logger';

/**
 * Exponential backoff capped at 5s for every raw ioredis client on REDIS_URL:
 * a provider blip (or a request-quota rejection — see createResilientRedisClient)
 * causes a slowing trickle of reconnect attempts instead of a tight retry
 * loop. Against a provider that bills or rate-limits per COMMAND, each failed
 * reconnect attempt (AUTH etc.) is itself a billed command — retrying as fast
 * as possible is exactly the wrong instinct once the failure IS the quota.
 */
const RETRY_STRATEGY: RedisOptions['retryStrategy'] = (attempt) => Math.min(attempt * 200, 5_000);

/**
 * Every raw `new Redis(...)` client must be constructed through this, never
 * directly: ioredis instances are EventEmitters, and Node's EventEmitter
 * contract THROWS — crashing the whole process — when an 'error' event fires
 * with zero listeners. Every ordinary connection failure (network blip,
 * provider restart, quota rejection) surfaces as exactly that event, so an
 * unhandled client is a crash waiting for the first transient Redis hiccup.
 *
 * `label` only tags the log line, to tell multiple clients apart in a shared
 * log stream.
 */
export function createResilientRedisClient(label: string, url: string = env.REDIS_URL, extraOptions: RedisOptions = {}): Redis {
  const client = new Redis(url, { retryStrategy: RETRY_STRATEGY, ...extraOptions });

  client.on('error', (err) => {
    // Logging here is what stands between a Redis error and an uncaught-
    // exception crash of the whole process. Nothing else is needed: ioredis
    // keeps retrying on its own (per RETRY_STRATEGY), an in-flight command
    // rejects to its caller's catch like any other failed await, and once
    // the connection recovers this same client resumes serving new commands
    // automatically.
    logger.error('Redis client error', { label, err });
  });

  return client;
}

// One general-purpose Redis connection for ordinary commands (INCR, EXPIRE,
// route cache, metrics counters, etc.). Never used for (p)subscribe — a
// connection that has called subscribe() can't run other commands, so pub/sub
// gets its own (see src/realtime/log-relay.ts). Deliberately stays on
// REDIS_URL, NOT REDIS_BUILDER_URL — that variable is BullMQ-only (see
// lib/queue.ts); everything importing `redis` from here is exactly the "all
// other tasks" half of that split.
export const redis = createResilientRedisClient('lib/redis');
