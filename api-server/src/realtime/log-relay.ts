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
// CHANGED — was 15_000. This interval runs an XAUTOCLAIM call FOREVER,
// 24/7, regardless of whether anything has actually crashed or has any
// pending entries to reclaim (XAUTOCLAIM against an empty pending-entries
// list is still one billed Redis command). At 15s that's 4 calls/minute —
// 172,800/month — spent purely on "checking if there's anything to clean
// up," on a Redis plan (Upstash free tier, notably) that bills per
// command. 60s cuts that to 43,200/month for the exact same behavior in
// the case that actually matters: recovering entries stranded by a
// crashed instance. The only real trade-off is how long a stranded entry
// sits before a healthy instance reclaims it — 15s vs 60s worst case,
// which only matters in the narrow window right after a crash, not during
// any normal operation.
const RECLAIM_INTERVAL_MS = 60_000;

// NEW — how long XREADGROUP blocks waiting for a new stream entry before
// returning empty and looping. This does NOT add latency to real events:
// XREADGROUP returns THE MOMENT a new entry arrives, no matter how large
// this number is — BLOCK is a ceiling on how long to wait when idle, not a
// polling delay. It only controls how often the loop re-issues the command
// when there is genuinely nothing to do. Was 5_000 — one XREADGROUP every
// 5s, 24/7 = 518,400/month spent on "is anything new yet? no. is anything
// new yet? no." with zero deploy activity. 30_000 cuts that to
// 86,400/month for identical real-time responsiveness on actual events —
// this is the single largest fix in this file, by an order of magnitude,
// for a command-billed Redis plan (see this codebase's own incident: an
// Upstash free-tier database hit its 500K/month command limit with this
// loop's baseline cost ALONE exceeding that limit before counting a single
// real deploy).
const STREAM_READ_BLOCK_MS = 30_000;

// NEW — worst-case ceiling on this loop's own lifetime once nothing has
// actually happened, INDEPENDENT of what Postgres says. This exists for a
// gap the Postgres-backed reconciliation (reconcileLogRelayActivity,
// deployment.service.ts) can't cover: a deployment stuck NON-TERMINAL
// forever — e.g. a build container that died without ever reporting a final
// status back — never satisfies "nothing active" from Postgres's point of
// view, so reconciliation would never call ensureConsumerStopped() for it,
// and this loop would poll 24/7 for the rest of that row's life. This is
// the actual worst case the whole gating effort exists to bound.
//
// Measured from the last time an entry was ACTUALLY received on the
// stream (see markActivity below), not from when polling started.
//
// Why 5 minutes, not something shorter: this stream carries ONLY status/
// image_ready transitions — a handful of coarse events per deployment's
// whole life (QUEUED→LAUNCHING→BUILDING→UPLOADING→RUNNING) — NOT log
// lines (those flow through the separate, always-on CHANNEL_PATTERN
// pub/sub below, unaffected by any of this gating). A single slow
// BUILDING phase (a large monorepo, a cold npm cache) can legitimately go
// several minutes between consecutive stream events with zero indication
// anything is wrong. A shorter timeout would false-positive on healthy,
// still-in-progress builds, not just stuck ones.
//
// Why self-stopping on a false positive is still safe, not a silent UX
// regression: this timeout only ever calls the SAME stop() the
// reconciliation safety net already knows how to undo. If a legitimately
// slow build times this out while Postgres still shows it non-terminal,
// reconcileLogRelayActivity's next tick (≤ LOG_RELAY_RECONCILE_INTERVAL_MS,
// currently 2 minutes — see index.ts) sees that and calls
// ensureConsumerRunning() again automatically — nothing is lost (Redis
// Streams' consumer-group delivery means the entry itself just sits
// undelivered in the meantime, not dropped), the worst case is up to ~2
// extra minutes of latency on that one deployment's live status push,
// once in a while, for a real deployment that was genuinely still
// working. That's a good trade against the alternative: polling forever
// for a deployment that may never produce another event at all.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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
    //  Unlike every other branch here, this one can take a few seconds (container
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
 *
 * CHANGED — this used to unconditionally run the XREADGROUP loop and the
 * XAUTOCLAIM reclaim interval for the entire process lifetime. Both are
 * now gated behind start()/stop(), registered with consumer-lifecycle.ts —
 * see that file's own comment for why (in short: this loop's idle cost was
 * a meaningful chunk of a real Redis-quota incident, and most of its life
 * is spent polling for events from deployments that aren't happening).
 * The connection itself (streamClient) and the consumer group
 * (ensureConsumerGroup) are still set up ONCE, unconditionally, at boot —
 * cheap, one-time costs, and reclaimAndProcessPending's initial sweep
 * still runs once at boot too, to recover anything stranded by a crash
 * before this instance existed, regardless of whether anything is active
 * right now.
 */
async function startDurableEventConsumer(io: Server): Promise<void> {
  const streamClient = createResilientRedisClient('log-relay-stream');
  await ensureConsumerGroup(streamClient);

  // Recover anything stranded by a previous instance before this instance
  // is even asked to start polling — a one-time startup cost regardless of
  // current activity, same reasoning as reconcileOrphanedQueuedDeployments's
  // own startup sweep (see index.ts).
  await reclaimAndProcessPending(streamClient, io).catch((err) => {
    logger.error('Initial pending-entry reclaim failed', { err });
  });

  let running = false;
  let reclaimInterval: ReturnType<typeof setInterval> | null = null;
  // NEW — see IDLE_TIMEOUT_MS's own comment for the full reasoning.
  // Reset to Date.now() at the TOP of every start() (not left stale from
  // a previous activation — a deployment that starts polling again 20
  // minutes after the last one stopped must get a FRESH 5-minute grace
  // period, not immediately self-timeout on its very first idle check),
  // and bumped forward by markActivity() every time an entry is actually
  // processed, from either the live loop or a reclaim sweep.
  let lastActivityAt = Date.now();

  function markActivity(): void {
    lastActivityAt = Date.now();
  }

  function start(): void {
    if (running) return; // idempotent — see consumer-lifecycle.ts's own comment on why callers rely on this
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

          // Re-check `running` after the (up to STREAM_READ_BLOCK_MS-long)
          // blocking call returns — this is the ACTUAL stop mechanism:
          // stop() below just flips the flag, and the loop exits cleanly
          // here on its own next wake-up instead of anything trying to
          // cancel an in-flight Redis command. Worst-case stop latency is
          // whatever's left of the current BLOCK window (≤ STREAM_READ_BLOCK_MS).
          if (!running) break;

          if (result) {
            const [[, entries]] = result;
            for (const [entryId, fields] of entries) {
              await handleStreamEntry(streamClient, io, entryId, fields);
            }
            if (entries.length > 0) markActivity();
          }
          // (no `else` needed — a null result is exactly "BLOCK timed out
          // with nothing new," which is precisely what should NOT reset
          // lastActivityAt; the idle check below is what that case feeds.)

          // NEW — see IDLE_TIMEOUT_MS's own comment for the full
          // reasoning. Checked every iteration regardless of whether this
          // one had entries (cheap: one Date.now() comparison, no Redis
          // cost) — trivially passes right after real activity since
          // markActivity() just ran, only actually fires after a genuine
          // stretch of silence.
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
    // The in-flight XREADGROUP call (if any) isn't cancelled — it simply
    // won't be followed by another one once it returns, per the `running`
    // check above. Nothing else to clean up: the connection itself stays
    // open (cheap to hold, and start() reuses it — reconnecting fresh
    // every start/stop cycle would trade a small Redis-command saving for
    // a much larger one in connection churn).
  }

  registerConsumerLifecycle({ start, stop });
}

export async function startLogRelay(io: Server): Promise<void> {
  const subscriber = createResilientRedisClient('log-relay-pubsub');
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
