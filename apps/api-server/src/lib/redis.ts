import Redis from 'ioredis';
import { env } from './env';

// One general-purpose Redis connection for ordinary commands (INCR, EXPIRE,
// etc.) shared across services. Never used for (p)subscribe — a Redis
// connection that has called subscribe() can no longer run other commands,
// so pub/sub gets its own dedicated connection (see src/realtime/log-relay.ts).
export const redis = new Redis(env.REDIS_URL);