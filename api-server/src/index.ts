import { createServer } from 'node:http';
import { app } from './app';
import { env } from './lib/env';
import { startRealtimeGateway } from './realtime';
import { startBuildWorker } from './workers/build.worker';
import { logger } from './lib/logger';
import { reconcileOrphanedQueuedDeployments, reconcileLogRelayActivity } from './deployments/deployment.service';
import { flushMetrics } from './metrics';

// One http.Server shared by Express (REST) and Socket.IO (realtime log/status
// push), so both are reachable through a single port.
const httpServer = createServer(app);

// Never fatal: startup awaits Redis consumer-group setup, and a Redis failure
// there must not take down the whole process — the build worker and every
// in-flight deploy live here too. Realtime log/status push just degrades.
startRealtimeGateway(httpServer).catch((err) => {
  logger.error('Realtime gateway failed to start — logs/status will not push live, but the API and build worker are unaffected', { err });
});

// The BullMQ build worker runs in this same process. If build volume ever
// warrants its own instance, run `npm run worker` as a separate service and
// delete this one line — everything else is unchanged either way.
const buildWorker = startBuildWorker();

// Self-heals deployments stuck QUEUED with no corresponding BullMQ job (a
// Redis blip or a restart landing between the DB write and the enqueue): runs
// once shortly after boot, then on a fixed interval while the process lives.
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
setTimeout(() => void reconcileOrphanedQueuedDeployments().catch((err) => logger.error('Startup queue reconciliation failed', { err })), 30_000);
const reconcileInterval = setInterval(
  () => void reconcileOrphanedQueuedDeployments().catch((err) => logger.error('Periodic queue reconciliation failed', { err })),
  RECONCILE_INTERVAL_MS
);

// Drains the Redis counters reverse-proxy's metrics-recorder writes into
// durable Postgres rows. Every flush costs ~9-11 Redis commands PER ACTIVE
// project-bucket, so the cadence stays modest: command volume scales with
// the number of projects actively receiving traffic and shouldn't be assumed
// free.
const METRICS_FLUSH_INTERVAL_MS = 120 * 1000; // 2 minutes
setTimeout(() => void flushMetrics().catch((err) => logger.error('Startup metrics flush failed', { err })), 15_000);
const metricsFlushInterval = setInterval(
  () => void flushMetrics().catch((err) => logger.error('Periodic metrics flush failed', { err })),
  METRICS_FLUSH_INTERVAL_MS
);

// Safety net for log-relay.ts's start/stop gating: the PRIMARY trigger is
// createDeploymentInternal calling ensureConsumerRunning() synchronously in
// the request that creates a deployment; this periodic sweep exists only to
// catch what that can't — a restart landing mid-deployment, and turning
// polling back off once nothing is active. Not latency-sensitive, hence the
// relaxed cadence.
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
  // together — a SIGTERM shouldn't kill an in-flight build-launch attempt
  // mid-call; worker.close() waits for the job currently processing first.
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    buildWorker.close(),
  ]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
