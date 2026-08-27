import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { appendLogLine, handleImageReady, recordCommitInfo, transitionDeploymentStatus } from '../deployments/deployment.service';
import { createResilientRedisClient } from '../lib/redis';
import { logger, runWithContext } from '../lib/logger';
import { isDeploymentEvent, type DeploymentEvent } from './realtime.types';
import { roomFor } from './socket.server';
import { DEPLOYMENT_EVENTS_GROUP, DEPLOYMENT_EVENTS_STREAM_KEY } from './deployment-events-stream';
import { registerConsumerLifecycle } from './consumer-lifecycle';

const CHANNEL_PATTERN = 'deployment:*';

// Unique per process boot — Redis Streams use this purely to track who owns a
// pending entry, not as a stable identity across restarts. A fresh name every
// boot means entries stranded by a previous instance are owned by a consumer
// that will never come back — exactly what reclaimAndProcessPending's
// XAUTOCLAIM sweep recovers.
const STREAM_CONSUMER = `log-relay-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

// How long an entry must sit unacked before it's eligible for reclaim — long
// enough that we don't race our own in-flight processing of it, short enough
// that a crash doesn't leave a deployment stuck for long.
const RECLAIM_MIN_IDLE_MS = 10_000;

// Reclaim-sweep cadence. XAUTOCLAIM runs on this interval forever regardless
// of whether anything is stranded, so the value trades idle Redis-command cost
// against how long a crash-stranded entry sits unprocessed — a latency that
// only matters in the narrow window right after a crash.
const RECLAIM_INTERVAL_MS = 60_000;

// How long XREADGROUP blocks waiting for a new entry before returning empty
// and looping. BLOCK returns THE MOMENT a real event arrives, so this adds no
// latency — it only controls how often the loop re-issues the command while
// idle.
const STREAM_READ_BLOCK_MS = 30_000;

// Worst-case ceiling on this loop's lifetime once nothing has happened,
// independent of Postgres: a deployment stuck non-terminal forever (e.g. a
// build container that died without ever reporting a final status) would
// otherwise be polled indefinitely, since reconciliation would never see
// "nothing active". Measured from the last entry ACTUALLY received on the
// stream (see markActivity), not from when polling started.
//
// Why 5 minutes: this stream carries ONLY coarse status/image_ready
// transitions (not log lines — those flow through the always-on pub/sub
// below), and a slow BUILDING phase can legitimately go several minutes
// between consecutive events. Shorter would false-positive on healthy builds.
//
// A false-positive self-stop is safe: reconcileLogRelayActivity's next tick
// (≤ LOG_RELAY_RECONCILE_INTERVAL_MS, ~2 minutes — see index.ts) sees Postgres
// still shows an active deployment and calls ensureConsumerRunning() again.
// Consumer-group delivery means the entry just sits undelivered meanwhile, so
// the worst case is a few extra minutes of latency on one deployment's live
// status push, occasionally — a good trade against polling forever.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handles exactly the two DeploymentEvent types that travel through the
 * durable stream (status/image_ready), shared by both the live XREADGROUP
 * loop and the periodic pending-entry reclaim sweep. Acks on success;
 * deliberately does NOT ack on failure — leaving the entry pending is what
 * lets reclaimAndProcessPending retry it later instead of silently dropping
 * the event.
 */
async function processStreamEvent(deploymentId: string, event: DeploymentEvent, io: Server): Promise<void> {
  if (event.type === 'image_ready') {
    // Unlike every other branch here, this one can take a few seconds
    // (container create + start) — deliberately awaited anyway.
    // handleImageReady itself emits the resulting status transition
    // (STARTING -> RUNNING or FAILED) via its own transitionDeploymentStatus call.
    const updated = await handleImageReady(deploymentId, event);
    if (updated) {
      io.to(roomFor(deploymentId)).emit('status', { status: updated.status, url: updated.url });
    }
  } else if (event.type === 'status') {
    const updated = await transitionDeploymentStatus(deploymentId, event.status, {
      reason: event.reason,
      url: event.url,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      errorStep: event.errorStep,
      uploadedFileCount: event.uploadedFileCount,
      triggeredBy: event.triggeredBy,
    });
    if (updated) {
      io.to(roomFor(deploymentId)).emit('status', { status: updated.status, url: updated.url });
    }
  } else {
    // Only status/image_ready are ever written to this stream (publish.ts /
    // build-engine's redis.js) — anything else here means the two sides have
    // drifted out of sync.
    logger.error('Unexpected event type on deployment-events-stream', { event });
  }
}

/** Parses ioredis's flat [key, value, key, value, ...] field array into an object. */
function fieldsToRecord(fields: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    record[fields[i]] = fields[i + 1];
  }
  return record;
}

async function handleStreamEntry(
  streamClient: Redis,
  io: Server,
  entryId: string,
  fields: string[]
): Promise<void> {
  const { deploymentId, payload } = fieldsToRecord(fields);

  const ack = () => streamClient.xack(DEPLOYMENT_EVENTS_STREAM_KEY, DEPLOYMENT_EVENTS_GROUP, entryId);

  let event: unknown;
  try {
    event = payload ? JSON.parse(payload) : undefined;
  } catch {
    logger.error('Non-JSON payload on deployment-events-stream', { entryId, payload });
    await ack(); // malformed — retrying won't fix it, don't let it block the stream forever
    return;
  }

  if (!deploymentId || !isDeploymentEvent(event)) {
    logger.error('Unrecognized entry shape on deployment-events-stream', { entryId, deploymentId, event });
    await ack();
    return;
  }

  await runWithContext({ correlationId: deploymentId, source: 'log-relay-stream' }, async () => {
    try {
      await processStreamEvent(deploymentId, event as DeploymentEvent, io);
      await ack();
    } catch (err) {
      // Deliberately not acking — see processStreamEvent. The periodic
      // reclaim sweep (or, worst case, the next startup sweep) retries it.
      logger.error('Failed to process stream event — leaving unacked for retry', { entryId, deploymentId, err });
    }
  });
}

/**
 * Sweeps the consumer group's pending-entries list for anything idle longer
 * than RECLAIM_MIN_IDLE_MS and reprocesses it under this process's own
 * consumer name. One mechanism covers both a previous instance crashing after
 * delivery but before ack (entry owned by a dead consumer name) and this
 * process failing to process an entry moments ago. Called once at startup
 * (recovers anything stranded before this boot) and then on an interval.
 */
async function reclaimAndProcessPending(streamClient: Redis, io: Server): Promise<number> {
  let cursor = '0-0';
  let processedCount = 0;
  for (;;) {
    const result = (await streamClient.xautoclaim(
      DEPLOYMENT_EVENTS_STREAM_KEY,
      DEPLOYMENT_EVENTS_GROUP,
      STREAM_CONSUMER,
      RECLAIM_MIN_IDLE_MS,
      cursor,
      'COUNT',
      50
    )) as [string, [string, string[]][], string[]?];

    const [nextCursor, claimed] = result;

    for (const [entryId, fields] of claimed) {
      await handleStreamEntry(streamClient, io, entryId, fields);
      processedCount++;
    }

    cursor = nextCursor;
    if (cursor === '0-0' || claimed.length === 0) break;
  }
  return processedCount;
}

async function ensureConsumerGroup(streamClient: Redis): Promise<void> {
  try {
    // '$' — deliver only entries added AFTER the group is created. Safe
    // because this runs only the first time the stream/group don't exist;
    // afterwards BUSYGROUP hits and the group's own server-side cursor
    // determines "new" — nothing created between restarts is skipped.
    await streamClient.xgroup('CREATE', DEPLOYMENT_EVENTS_STREAM_KEY, DEPLOYMENT_EVENTS_GROUP, '$', 'MKSTREAM');
  } catch (err) {
    if (err instanceof Error && err.message.includes('BUSYGROUP')) {
      return; // already exists — expected on every restart after the first
    }
    throw err;
  }
}

/**
 * Durable counterpart to the Pub/Sub psubscribe loop below, for the two
 * event types (`status`, `image_ready`) that drive a Deployment row's status
 * column. Redis Streams + a consumer group give at-least-once delivery: an
 * entry stays in the stream (and, once delivered, in the group's
 * pending-entries list) until explicitly XACK'd, so a restart or brief Redis
 * disconnect can't lose a transition the way a missed PUBLISH would — see
 * publish.ts and build-engine's redis.js for the producer side.
 */
async function startDurableEventConsumer(io: Server): Promise<void> {
  const streamClient = createResilientRedisClient('log-relay-stream');
  await ensureConsumerGroup(streamClient);

  // One-time recovery of anything stranded before this boot, regardless of
  // current activity (same reasoning as reconcileOrphanedQueuedDeployments's
  // startup sweep in index.ts).
  await reclaimAndProcessPending(streamClient, io).catch((err) => {
    logger.error('Initial pending-entry reclaim failed', { err });
  });

  let running = false;
  let reclaimInterval: ReturnType<typeof setInterval> | null = null;
  // Reset fresh at every start() (a deployment that starts polling long after
  // the last one stopped must get a full grace period), bumped forward by
  // markActivity() on every processed entry — see IDLE_TIMEOUT_MS.
  let lastActivityAt = Date.now();

  function markActivity(): void {
    lastActivityAt = Date.now();
  }

  function start(): void {
    if (running) return; // idempotent — callers rely on this (see consumer-lifecycle.ts)
    running = true;
    lastActivityAt = Date.now();
    logger.info('Starting deployment-events-stream consumer (deployment activity detected)');

    reclaimInterval = setInterval(() => {
      reclaimAndProcessPending(streamClient, io)
        .then((processedCount) => {
          if (processedCount > 0) markActivity();
        })
        .catch((err) => {
          logger.error('Periodic pending-entry reclaim failed', { err });
        });
    }, RECLAIM_INTERVAL_MS);
    reclaimInterval.unref?.();

    void (async () => {
      while (running) {
        try {
          const result = (await streamClient.xreadgroup(
            'GROUP',
            DEPLOYMENT_EVENTS_GROUP,
            STREAM_CONSUMER,
            'COUNT',
            10,
            'BLOCK',
            STREAM_READ_BLOCK_MS,
            'STREAMS',
            DEPLOYMENT_EVENTS_STREAM_KEY,
            '>'
          )) as [string, [string, string[]][]][] | null;

          // Re-check `running` after the blocking call — this is the actual
          // stop mechanism: stop() only flips the flag, and the loop exits
          // here on its own next wake-up rather than cancelling an in-flight
          // Redis command. Worst-case stop latency is whatever remains of the
          // current BLOCK window.
          if (!running) break;

          if (result) {
            const [[, entries]] = result;
            for (const [entryId, fields] of entries) {
              await handleStreamEntry(streamClient, io, entryId, fields);
            }
            if (entries.length > 0) markActivity();
          }
          // (null result = BLOCK timed out idle — exactly the case that must
          // NOT reset lastActivityAt.)

          // Idle check — see IDLE_TIMEOUT_MS. Trivially passes right after
          // real activity since markActivity() just ran.
          if (Date.now() - lastActivityAt >= IDLE_TIMEOUT_MS) {
            logger.warn(
              'deployment-events-stream consumer self-stopping after 5 minutes of silence — if Postgres still shows an active deployment, reconcileLogRelayActivity will restart this within LOG_RELAY_RECONCILE_INTERVAL_MS; if this happens often for the same deployment, it likely means that deployment is stuck (e.g. a build container that died without reporting a final status), worth checking',
              { idleMs: Date.now() - lastActivityAt }
            );
            stop();
            break;
          }
        } catch (err) {
          logger.error('deployment-events-stream read loop error', { err });
          await sleep(1_000); // avoid a tight crash loop if Redis is briefly unreachable
        }
      }
    })();
  }

  function stop(): void {
    if (!running) return; // idempotent
    running = false;
    logger.info('Stopping deployment-events-stream consumer');
    if (reclaimInterval) {
      clearInterval(reclaimInterval);
      reclaimInterval = null;
    }
    // No cancellation needed: the in-flight XREADGROUP (if any) simply won't
    // be followed by another one once it returns. The connection itself stays
    // open — start() reuses it, avoiding reconnect churn across cycles.
  }

  registerConsumerLifecycle({ start, stop });
}

export async function startLogRelay(io: Server): Promise<void> {
  const subscriber = createResilientRedisClient('log-relay-pubsub');
  await subscriber.psubscribe(CHANNEL_PATTERN);

  subscriber.on('pmessage', (_pattern: string, channel: string, raw: string) => {
    const deploymentId = channel.slice('deployment:'.length);

    // Same correlationId (the deploymentId) that launched the build — every
    // log line for this deployment, system-wide, is greppable by one ID.
    void runWithContext({ correlationId: deploymentId, source: 'log-relay' }, async () => {
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        logger.error('Non-JSON message on channel', { channel, raw });
        return;
      }

      if (!isDeploymentEvent(event)) {
        logger.error('Unrecognized event shape on channel', { channel, event });
        return;
      }

      try {
        if (event.type === 'log') {
          const log = await appendLogLine(deploymentId, event);
          io.to(roomFor(deploymentId)).emit('log', log);
        } else if (event.type === 'commit_info') {
          // Metadata only, no status change — nothing live to emit; the
          // deployment detail page re-fetches on mount.
          await recordCommitInfo(deploymentId, event);
        } else {
          // status / image_ready normally arrive via the durable stream above;
          // handling them here is a defensive fallback.
          await processStreamEvent(deploymentId, event, io);
        }
      } catch (err) {
        logger.error('Failed to process event', { err });
      }
    });
  });

  await startDurableEventConsumer(io);
}
