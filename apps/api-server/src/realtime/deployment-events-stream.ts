/**
 * NEW. Constants for the durable Redis Stream that carries `status` and
 * `image_ready` events — the two DeploymentEvent types that drive a
 * Deployment row's status column and therefore can't be silently dropped.
 * (`log` and `commit_info` stay on the plain `deployment:*` Pub/Sub channel
 * — see log-relay.ts's psubscribe branch — because losing a log line or
 * commit metadata is cosmetic, not a stuck deployment.)
 *
 * MUST match apps/build-engine/redis.js's STREAM_KEY exactly — same
 * by-hand-sync caveat as CHANNEL/realtime.types.ts already have, since
 * build-engine is a separate plain-Node app with no shared package to
 * enforce this for you.
 */
export const DEPLOYMENT_EVENTS_STREAM_KEY = 'deployment-events-stream';

/**
 * One consumer group, shared by every api-server process/replica. A
 * message is delivered to exactly one member of the group — if you scale
 * api-server horizontally, every replica reads from the SAME group (not
 * one group each), so a given event is still only processed once.
 */
export const DEPLOYMENT_EVENTS_GROUP = 'log-relay-group';

/** Approx trim on every XADD (build-engine side) — see redis.js's STREAM_MAXLEN comment. */
export const DEPLOYMENT_EVENTS_STREAM_MAXLEN = 100_000;
