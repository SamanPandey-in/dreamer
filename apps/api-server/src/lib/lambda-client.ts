import { LambdaClient } from '@aws-sdk/client-lambda';
import { env } from './env';

// One lambda client for the lifetime for one purpose - same rationale as
// lib/ecs-client.ts and lib/s3-client.ts: construct once, reuse everywhere,
// rather than paying credential resolution overhead per call

export const lambdaClient = new LambdaClient({
    region: env.AWS_REGION,
    credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
    },
});
