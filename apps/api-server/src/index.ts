import { createServer } from 'node:http';
import { app } from './app';
import { env } from './lib/env';
import { startRealtimeGateway } from './realtime';

// One http.Server shared by Express (REST) and Socket.IO (realtime log/status
// push) — see realtime/socket.server.ts's comment for why this matters on
// Render/Vercel specifically, where only one port per service is reachable
// from the internet.
const httpServer = createServer(app);

startRealtimeGateway(httpServer);

httpServer.listen(env.PORT, () => {
  console.log(`API server (HTTP + realtime) is running on port ${env.PORT}`);
});
