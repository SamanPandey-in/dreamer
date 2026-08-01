import type { Server as HttpServer } from 'node:http';
import { startLogRelay } from './log-relay';
import { createSocketServer } from './socket.server';

/**
 * Called once from src/index.ts at process boot, with the SAME http.Server
 * that Express listens on — see socket.server.ts's comment for why this
 * used to be a separate port (9002) and why that broke on Render/Vercel.
 */
export async function startRealtimeGateway(httpServer: HttpServer): Promise<void> {
  const io = createSocketServer(httpServer);
  console.log('Realtime gateway attached to the main HTTP server');

  await startLogRelay(io);
  console.log('Subscribed to deployment:* for log + status relay');
}
