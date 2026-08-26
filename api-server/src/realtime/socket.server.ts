import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/auth.tokens';
import { assertDeploymentOwnership } from '../deployments/deployment.service';
import { env } from '../lib/env';

interface AuthedSocket extends Socket {
  userId?: string;
}

export function roomFor(deploymentId: string): string {
  return `deployment:${deploymentId}`;
}

/**
 * One Socket.IO server for the whole process, created once and handed to
 * log-relay.ts — the only thing that ever emits through it.
 *
 * Attached to the SAME http.Server as the Express app (see src/index.ts), not
 * given its own port: hosting environments only forward external traffic to
 * one port per service. Socket.IO intercepts requests under its own `path`
 * before Express's router, so REST calls and the WebSocket upgrade share the
 * one publicly exposed port.
 */
export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, { cors: { origin: env.FRONTEND_URL, credentials: true } });

  // Auth happens ONCE, at connection time — a socket that never presented a
  // valid access token never even reaches the 'subscribe' handler below.
  io.use((socket: AuthedSocket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('UNAUTHORIZED'));

    try {
      const payload = verifyAccessToken(token);
      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: AuthedSocket) => {
    socket.on('subscribe', async (deploymentId: string) => {
      // The access token only proves WHO is asking — not that they may watch
      // THIS deployment. Without this ownership check any logged-in user
      // could read another user's build output by guessing a UUID (IDOR).
      try {
        await assertDeploymentOwnership(deploymentId, socket.userId!);
        socket.join(roomFor(deploymentId));
      } catch {
        socket.emit('error', { message: 'Not found or not authorized' });
      }
    });

    socket.on('unsubscribe', (deploymentId: string) => {
      socket.leave(roomFor(deploymentId));
    });
  });

  return io;
}
