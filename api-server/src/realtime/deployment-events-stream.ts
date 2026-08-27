/**
 * Constants for the durable Redis Stream that carries `status` and
 * `image_ready` events — the two DeploymentEvent types that drive a
 * Deployment row's status column and therefore can't be silently dropped.
 * (`log` and `commit_info` stay on the plain `deployment:*` Pub/Sub channel
 * — see log-relay.ts's psubscribe branch — because losing a log line or
 * commit metadata is cosmetic, not a stuck deployment.)
 *
 * MUST match build-engine/redis.js's STREAM_KEY exactly — kept in sync by
 * hand, since build-engine is a separate plain-Node app with no shared
 * package to enforce this for you.
 */
export const DEPLOYMENT_EVENTS_STREAM_KEY = 'deployment-events-stream';

/**
 * One consumer group, shared by every api-server process/replica. A
 * message is delivered to exactly one member of the group — if you scale
 * api-server horizontally, every replica reads from the SAME group (not
 * one group each), so a given event is still only processed once.
 */
export const DEPLOYMENT_EVENTS_GROUP = 'log-relay-group';

/** Approximate trim applied on every XADD — kept in sync with build-engine/redis.js's STREAM_MAXLEN. */
export const DEPLOYMENT_EVENTS_STREAM_MAXLEN = 100_000;
