import { createServer } from 'node:http';
import { app } from './app';
import { env } from './lib/env';
import { startRealtimeGateway } from './realtime';
import { startBuildWorker } from './workers/build.worker';
import { logger } from './lib/logger';

// One http.Server shared by Express (REST) and Socket.IO (realtime log/status
// push) — see realtime/socket.server.ts's comment for why this matters on
// Render/Vercel specifically, where only one port per service is reachable
// from the internet.
const httpServer = createServer(app);

startRealtimeGateway(httpServer);

// Runs the BullMQ build worker IN this same process/instance, instead of as
// a separate service — one Render service instead of two. Nothing about
// startBuildWorker() cares which process calls it (see its own comment);
// if build volume ever grows enough to want it split back out onto its own
// instance, run `npm run worker` as a separate service instead and delete
// this one line — everything else is unchanged either way.
const buildWorker = startBuildWorker();

const server = httpServer.listen(env.PORT, () => {
  logger.info(`API server (HTTP + realtime + build worker) is running on port ${env.PORT}`);
});

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  // Stop accepting new HTTP connections and close the in-process worker
  // together — a SIGTERM (Render redeploying this instance, e.g.) shouldn't
  // kill an in-flight ECS launch attempt mid-call; worker.close() waits for
  // whatever job is currently processing to finish first.
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    buildWorker.close(),
  ]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
