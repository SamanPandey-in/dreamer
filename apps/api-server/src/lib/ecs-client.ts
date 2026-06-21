import { ECSClient } from '@aws-sdk/client-ecs';
import { env } from './env';

// One ECS client for the lifetime of the process — same rationale as lib/prisma.ts:
// the SDK manages its own credential resolution and connection pooling
// internally, so constructing a new client per request (or per deployment)
// is pure waste, and for credential providers that hit STS, can even get us
// rate-limited under load.
export const ecsClient = new ECSClient({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});