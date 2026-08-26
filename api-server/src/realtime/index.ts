import type { Server as HttpServer } from 'node:http';
import { startLogRelay } from './log-relay';
import { createSocketServer } from './socket.server';

/**
 * Called once from src/index.ts at process boot, with the SAME http.Server
 * that Express listens on (see socket.server.ts).
 */
export async function startRealtimeGateway(httpServer: HttpServer): Promise<void> {
  const io = createSocketServer(httpServer);
  console.log('Realtime gateway attached to the main HTTP server');

  await startLogRelay(io);
  console.log('Subscribed to deployment:* for log + status relay');
}
