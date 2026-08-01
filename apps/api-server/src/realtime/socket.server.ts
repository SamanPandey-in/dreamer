import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/auth.tokens';
import { assertDeploymentOwnership } from '../deployments/deployment.service'; // concrete file — see §3.6 DASHBOARD_BACKEND_IMPL.md
import { env } from '../lib/env';

interface AuthedSocket extends Socket {
  userId?: string;
}

export function roomFor(deploymentId: string): string {
  return `deployment:${deploymentId}`;
}

/**
 * One Socket.IO server for the whole process, created once and handed to
 * log-relay.ts below — the only thing that ever emits through it.
 *
 * Attached to the SAME http.Server as the Express app (see src/index.ts),
 * not given its own port. This used to listen on its own port (9002) —
 * that only worked in local dev, where every port on localhost is directly
 * reachable. Render (and most PaaS providers, and Vercel's own edge) only
 * forward external traffic to ONE port per service: whatever's in the PORT
 * env var. Port 9002 was simply never reachable from the internet once
 * deployed, so the browser's socket.io-client sat there endlessly retrying
 * a connection that could never succeed — every 'log'/'status' push was
 * silently lost, and the only way to see current state was a hard reload
 * (which goes through the REST API on the port that IS public). Sharing
 * the HTTP server fixes this structurally: Socket.IO intercepts requests
 * under its own `path` before they reach Express's router, so both HTTP
 * REST calls and the WebSocket upgrade now go over the one port every
 * platform actually exposes.
 */
export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, { cors: { origin: env.FRONTEND_URL, credentials: true } });

  // Auth happens ONCE, at connection time — not re-checked per event. A
  // socket that never presented a valid access token never even reaches the
  // 'subscribe' handler below; Socket.IO rejects the connection outright.
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
      // The access token only proves WHO is asking — not that they're
      // allowed to watch THIS deployment's logs. Skipping this re-check is
      // the multi-tenant version of an IDOR bug: any logged-in user could
      // otherwise read any other user's build output by guessing a UUID and
      // emitting 'subscribe' with it — exactly the gap the unauthenticated
      // prototype (app/demo/page.tsx's socket.emit('subscribe', ...)) had,
      // harmlessly, before there were multiple users to leak data between.
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
