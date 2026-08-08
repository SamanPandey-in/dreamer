import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { appendLogLine, handleImageReady, recordCommitInfo, transitionDeploymentStatus } from '../deployments/deployment.service';
import { env } from '../lib/env';
import { logger, runWithContext } from '../lib/logger';
import { isDeploymentEvent, type DeploymentEvent } from './realtime.types';
import { roomFor } from './socket.server';
import { DEPLOYMENT_EVENTS_GROUP, DEPLOYMENT_EVENTS_STREAM_KEY } from './deployment-events-stream';

const CHANNEL_PATTERN = 'deployment:*';

// Unique per process boot — ioredis/Redis Streams use this purely to track
// "who currently owns this pending entry," not as a stable identity across
// restarts. A fresh name every boot is fine (even desirable): it means any
// entry a previous instance had claimed-but-not-acked shows up as owned by
// a consumer that will never come back, which is exactly what
// reclaimAndProcessPending's XAUTOCLAIM sweep is for.
const STREAM_CONSUMER = `log-relay-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

// How long an entry has to sit unacked before we'll reclaim it — long
// enough that we're not racing our own in-flight processing of it, short
// enough that a crash doesn't leave a deployment stuck for long.
const RECLAIM_MIN_IDLE_MS = 10_000;
const RECLAIM_INTERVAL_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handles exactly the two DeploymentEvent types that ever travel through
 * the durable stream — status/image_ready — shared by both the live
 * XREADGROUP loop and the periodic pending-entry reclaim sweep below.
 * Acks on success. Deliberately does NOT ack on failure: leaving the entry
 * pending is what lets reclaimAndProcessPending retry it later instead of
 * the failure silently dropping the event.
 */
async function processStreamEvent(deploymentId: string, event: DeploymentEvent, io: Server): Promise<void> {
  if (event.type === 'image_ready') {
    //  Unlike every other branch here, this one can take 10–60s (Lambda
    // CreateFunction + waiting for State: Active) — deliberately awaited
    // anyway. handleImageReady itself is responsible for emitting the
    // resulting status transition (STARTING -> RUNNING or FAILED) to
    // connected sockets — see its own call to transitionDeploymentStatus.
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
    // publish.ts / build-engine's redis.js only ever write status/image_ready
    // onto this stream — anything else getting here means the two sides
    // have drifted out of sync with each other.
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
      // NOT acking on purpose — see processStreamEvent's comment. The
      // periodic reclaim sweep (or, worst case, the next api-server
      // restart's own startup sweep) will pick this back up.
      logger.error('Failed to process stream event — leaving unacked for retry', { entryId, deploymentId, err });
    }
  });
}

/**
 * Sweeps the consumer group's pending-entries list for anything idle more
 * than RECLAIM_MIN_IDLE_MS and reprocesses it under this process's own
 * consumer name. Covers two cases with one mechanism: (1) a previous
 * api-server instance crashed after XREADGROUP delivered an entry but
 * before it acked — that entry is stuck "owned" by a consumer name that
 * will never come back; (2) this same process failed to process an entry a
 * moment ago and it's still sitting there under our own name, needing a
 * retry. Called once at startup (recovers anything stranded before this
 * boot) and then on an interval.
 */
async function reclaimAndProcessPending(streamClient: Redis, io: Server): Promise<void> {
  let cursor = '0-0';
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
    }

    cursor = nextCursor;
    if (cursor === '0-0' || claimed.length === 0) break;
  }
}

async function ensureConsumerGroup(streamClient: Redis): Promise<void> {
  try {
    // '$' — only deliver entries added AFTER the group is created. Safe
    // because this only runs the very first time the stream/group don't
    // exist yet; every subsequent boot hits BUSYGROUP below and the
    // group's own server-side last-delivered-id cursor (not this call)
    // is what determines "new" from then on — nothing created between
    // restarts is skipped.
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
 * event types (`status`, `image_ready`) that drive a Deployment row's
 * status column. Redis Streams + a consumer group gives at-least-once
 * delivery: an entry stays in the stream (and, once delivered, in the
 * group's pending-entries list) until explicitly XACK'd, so a restart or a
 * brief Redis disconnect no longer means a FAILED/CANCELLED/STOPPED/RUNNING
 * transition is gone forever the way a missed PUBLISH would be — see
 * publish.ts and build-engine's redis.js for the producer side.
 */
async function startDurableEventConsumer(io: Server): Promise<void> {
  const streamClient = new Redis(env.REDIS_URL);
  await ensureConsumerGroup(streamClient);

  // Recover anything stranded by a previous instance before joining the
  // live loop, then keep sweeping on an interval for retries of this
  // instance's own failures.
  await reclaimAndProcessPending(streamClient, io).catch((err) => {
    logger.error('Initial pending-entry reclaim failed', { err });
  });
  setInterval(() => {
    reclaimAndProcessPending(streamClient, io).catch((err) => {
      logger.error('Periodic pending-entry reclaim failed', { err });
    });
  }, RECLAIM_INTERVAL_MS).unref();

  void (async () => {
    for (;;) {
      try {
        const result = (await streamClient.xreadgroup(
          'GROUP',
          DEPLOYMENT_EVENTS_GROUP,
          STREAM_CONSUMER,
          'COUNT',
          10,
          'BLOCK',
          5_000,
          'STREAMS',
          DEPLOYMENT_EVENTS_STREAM_KEY,
          '>'
        )) as [string, [string, string[]][]][] | null;

        if (!result) continue; // BLOCK timed out with nothing new — loop again

        const [[, entries]] = result;
        for (const [entryId, fields] of entries) {
          await handleStreamEntry(streamClient, io, entryId, fields);
        }
      } catch (err) {
        logger.error('deployment-events-stream read loop error', { err });
        await sleep(1_000); // avoid a tight crash loop if Redis is briefly unreachable
      }
    }
  })();
}

export async function startLogRelay(io: Server): Promise<void> {
  const subscriber = new Redis(env.REDIS_URL);
  await subscriber.psubscribe(CHANNEL_PATTERN);

  subscriber.on('pmessage', (_pattern: string, channel: string, raw: string) => {
    const deploymentId = channel.slice('deployment:'.length);

    // Same correlationId (the deploymentId) as build.worker.ts used to
    // launch this build — every log line from here on for this deployment,
    // across every part of the system, is greppable by one ID.
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
          //  NEW — metadata only, no status change, nothing to emit to
          // connected sockets for it (the deployment detail page re-fetches
          // on mount; there's no live UI element keyed off commit info today
          // that would need a push).
          await recordCommitInfo(deploymentId, event);
        } else {
          // status / image_ready — producers no longer publish these here
          // (see publish.ts / build-engine's redis.js, both moved to the
          // durable stream below). Kept as a defensive fallback rather than
          // removed outright, in case an old build-engine image is still
          // running mid-rollout and publishes the old way.
          await processStreamEvent(deploymentId, event, io);
        }
      } catch (err) {
        logger.error('Failed to process event', { err });
      }
    });
  });

  await startDurableEventConsumer(io);
}
