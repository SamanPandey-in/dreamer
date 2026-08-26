import { createServer } from 'node:http';
import { app } from './app';
import { env } from './lib/env';
import { startRealtimeGateway } from './realtime';
import { startBuildWorker } from './workers/build.worker';
import { logger } from './lib/logger';
import { reconcileOrphanedQueuedDeployments, reconcileLogRelayActivity } from './deployments/deployment.service';
import { flushMetrics } from './metrics';

// One http.Server shared by Express (REST) and Socket.IO (realtime log/status
// push) — see realtime/socket.server.ts's comment for why this matters on
// Render/Vercel specifically, where only one port per service is reachable
// from the internet.
const httpServer = createServer(app);

// FIX — this used to be a bare fire-and-forget call with no .catch().
// startRealtimeGateway ultimately awaits ensureConsumerGroup's `XGROUP
// CREATE` (log-relay.ts) as part of its own startup — a Redis error there
// (this is EXACTLY what a Redis provider's request-quota error looks like:
// see the top-level README's Redis notes) rejected
// that promise with nothing downstream to catch it, which Node treats as
// fatal by default: the WHOLE process died, taking the build worker and
// every in-flight deploy down with it over something that should have
// only degraded realtime log/status push. Log-relay failing to start is
// real and worth knowing about loudly — it must never be fatal to the
// process that also runs the build worker.
startRealtimeGateway(httpServer).catch((err) => {
  logger.error('Realtime gateway failed to start — logs/status will not push live, but the API and build worker are unaffected', { err });
});

// Runs the BullMQ build worker IN this same process/instance, instead of as
// a separate service — one Render service instead of two. Nothing about
// startBuildWorker() cares which process calls it (see its own comment);
// if build volume ever grows enough to want it split back out onto its own
// instance, run `npm run worker` as a separate service instead and delete
// this one line — everything else is unchanged either way.
const buildWorker = startBuildWorker();

// FIX — self-healing for deployments stuck at QUEUED with no corresponding
// BullMQ job (e.g. a Redis blip or a restart landing between the DB write
// and the enqueue call — see reconcileOrphanedQueuedDeployments's own
// comment). Runs once shortly after boot (covers whatever was stuck before
// this restart) and then on a fixed interval so it also catches one that
// goes stale while the process keeps running, not just at startup.
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
setTimeout(() => void reconcileOrphanedQueuedDeployments().catch((err) => logger.error('Startup queue reconciliation failed', { err })), 30_000);
const reconcileInterval = setInterval(
  () => void reconcileOrphanedQueuedDeployments().catch((err) => logger.error('Periodic queue reconciliation failed', { err })),
  RECONCILE_INTERVAL_MS
);

// CHANGED — was 60s. Drains the Redis counters apps/reverse-proxy writes
// (see metrics/metrics-aggregator.ts's own comment) into durable Postgres
// rows. Every flush costs ~9-11 Redis commands PER ACTIVE project-bucket
// (SMEMBERS is shared/amortized across all buckets, but the GETDELs +
// PFCOUNT are per-bucket) — at 60s cadence against a 5-minute bucket
// width, one bucket gets flushed ~5 times over its life; at 120s, ~2.5
// times, roughly halving this job's own command volume for the same data.
// Same reasoning as log-relay.ts's STREAM_READ_BLOCK_MS/RECLAIM_INTERVAL_MS
// bumps (see that file's comment for the bigger of the two fixes made
// alongside this one) — this codebase previously exhausted an Upstash
// free-tier's 500K-commands/month limit, and this job's flush cadence,
// while smaller than log-relay's fixed 24/7 cost, scales with the number
// of projects actively receiving traffic, which is exactly the number
// that grows as this product gets more real usage — worth keeping modest
// by default rather than assuming Redis command volume is free.
const METRICS_FLUSH_INTERVAL_MS = 120 * 1000; // 2 minutes
setTimeout(() => void flushMetrics().catch((err) => logger.error('Startup metrics flush failed', { err })), 15_000);
const metricsFlushInterval = setInterval(
  () => void flushMetrics().catch((err) => logger.error('Periodic metrics flush failed', { err })),
  METRICS_FLUSH_INTERVAL_MS
);

// NEW — the safety net half of log-relay.ts's start/stop gating (see
// consumer-lifecycle.ts's own comment for the full design). The PRIMARY
// trigger is createDeploymentInternal calling ensureConsumerRunning()
// directly, synchronously, in the same request that creates a deployment
// — this periodic check exists only to catch what that can't: a restart
// landing mid-deployment, and eventually turning polling back off once
// nothing is active. 10s startup delay (vs the other jobs' 15-30s) is
// deliberate — this one specifically wants to run before a very early
// deployment creation could plausibly race past it, though
// ensureConsumerRunning() degrades safely even if called first (see its
// own comment). 2 minutes matches METRICS_FLUSH_INTERVAL_MS for
// consistency — how quickly this should notice "nothing's active anymore"
// isn't latency-sensitive the way the instant-start path is.
const LOG_RELAY_RECONCILE_INTERVAL_MS = 120 * 1000; // 2 minutes
setTimeout(() => void reconcileLogRelayActivity().catch((err) => logger.error('Startup log-relay activity reconciliation failed', { err })), 10_000);
const logRelayReconcileInterval = setInterval(
  () => void reconcileLogRelayActivity().catch((err) => logger.error('Periodic log-relay activity reconciliation failed', { err })),
  LOG_RELAY_RECONCILE_INTERVAL_MS
);

const server = httpServer.listen(env.PORT, () => {
  logger.info(`API server (HTTP + realtime + build worker) is running on port ${env.PORT}`);
});

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  clearInterval(reconcileInterval);
  clearInterval(metricsFlushInterval);
  clearInterval(logRelayReconcileInterval);
  // Stop accepting new HTTP connections and close the in-process worker
  // together — a SIGTERM (Render redeploying this instance, e.g.) shouldn't
  // kill an in-flight build-launch attempt mid-call; worker.close() waits for
  // whatever job is currently processing to finish first.
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    buildWorker.close(),
  ]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
