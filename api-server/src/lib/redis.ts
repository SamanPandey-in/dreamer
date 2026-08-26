import Redis, { type RedisOptions } from 'ioredis';
import { env } from './env';
import { logger } from './logger';

/**
 * NEW. Standard retry/backoff for every raw ioredis client this codebase
 * creates on REDIS_URL — exponential backoff capped at 5s, so a Redis
 * provider blip (or, notably, a request-quota rejection — see
 * createResilientRedisClient's own comment) causes a slowing trickle of
 * reconnect attempts instead of a tight retry loop hammering the same
 * error over and over. A tight reconnect loop against a Redis provider
 * that bills or rate-limits per COMMAND (Upstash does — every command
 * counts toward the plan limit regardless of whether it's pipelined; see
 * https://upstash.com/docs/redis/troubleshooting/max_requests_limit) can
 * itself prolong an outage: each failed reconnect attempt (AUTH, etc.) is
 * its own billed command, so retrying as fast as possible is exactly the
 * wrong instinct once the failure IS the quota itself.
 */
const RETRY_STRATEGY: RedisOptions['retryStrategy'] = (attempt) => Math.min(attempt * 200, 5_000);

/**
 * NEW. Every raw `new Redis(...)` client in this codebase should be
 * constructed through this, not called directly — see index.ts/log-relay.ts's
 * own comments for what happens when it isn't: ioredis's Redis instances
 * are EventEmitters, and Node's EventEmitter contract THROWS (crashing the
 * whole process, no matter what else that process is doing) when an
 * 'error' event fires with zero listeners attached. Every ordinary
 * connection failure — a brief network blip, a provider restart, a
 * request-quota rejection — surfaces as exactly that event. A client
 * built without an .on('error', ...) handler isn't "fine until something
 * goes wrong"; it's a crash waiting for the first transient Redis hiccup,
 * which is a `when`, not an `if`, for anything long-running in production.
 *
 * `label` is only for the log line — enough to tell log-relay's stream
 * client apart from its pub/sub client apart from lib/redis.ts's own
 * general-purpose client in a shared log stream.
 */
export function createResilientRedisClient(label: string, url: string = env.REDIS_URL, extraOptions: RedisOptions = {}): Redis {
  const client = new Redis(url, { retryStrategy: RETRY_STRATEGY, ...extraOptions });

  client.on('error', (err) => {
    // This is the ENTIRE fix — logging here is what stands between a
    // Redis error and an uncaught-exception crash of the whole process.
    // Nothing else needs to happen: ioredis keeps retrying the connection
    // on its own (per RETRY_STRATEGY above) after this fires: a client
    // command already in flight rejects (its own caller's try/catch or
    // .catch() handles that, same as any other failed await), and once
    // the connection recovers, ioredis resumes serving new commands
    // through this same client automatically — no manual reconnect logic
    // needed here.
    logger.error('Redis client error', { label, err });
  });

  return client;
}

// One general-purpose Redis connection for ordinary commands (INCR, EXPIRE,
// etc.) shared across services — route cache, metrics counters, etc.
// Never used for (p)subscribe — a Redis connection that has called
// subscribe() can no longer run other commands, so pub/sub gets its own
// dedicated connection (see src/realtime/log-relay.ts).
//
// Deliberately stays on REDIS_URL, NOT REDIS_BUILDER_URL — that variable
// is BullMQ-only (see lib/queue.ts's own comment for why it's a separate
// instance). Everything that imports `redis` from this file is exactly
// the "all other tasks" half of that split.
export const redis = createResilientRedisClient('lib/redis');
