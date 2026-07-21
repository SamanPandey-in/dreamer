// single validate config file for env variables
// this is done so every other file imports env, never process.env directly
// due to this, a missing or malformed variable will throw an error on startup instead of at runtime
// we are following a LLD pattern here and avoiding/solving runtime bugs beforehand

import 'dotenv/config';
import { z } from 'zod';

// here we are defining the schema for validation from zod, which is a TypeScript-first schema declaration and validation library
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8000),
  FRONTEND_URL: z.url(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_CA_CERT: z.string().min(1, 'DATABASE_CA_CERT is required (the PEM contents of your Postgres CA certificate)').optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),

  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)'),

  GITHUB_CLIENT_ID: z.string().min(1, 'GITHUB_CLIENT_ID is required'),
  GITHUB_CLIENT_SECRET: z.string().min(1, 'GITHUB_CLIENT_SECRET is required'),
  GITHUB_CALLBACK_URL: z.url(),

  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  TASK_DEFINITION_IMAGE_NAME: z.string().optional(),
  ECS_CLUSTER_ARN: z.string().optional(),
  ECS_TASK_DEFINITION_ARN: z.string().optional(),
  ECS_SUBNET1_ARN: z.string().optional(),
  ECS_SUBNET2_ARN: z.string().optional(),
  ECS_SUBNET3_ARN: z.string().optional(),
  ECS_SECURITY_GROUP_ARN: z.string().optional(),
  // Needed to clean up a project's live S3 output on delete (lib/s3-client.ts).
  // Optional, like the other AWS_*/ECS_* fields above — a setup that hasn't
  // wired up AWS at all shouldn't fail to boot over a feature it isn't using.
  S3_BUCKET: z.string().optional(),

  // NEW - DYNAMIC (SSR) apps. All optional, same reasoning as ECS_* above: a
  // setup that never deploys a Next.js SSR project shouldn't be forced to
  // configure Lambda just to boot. See lib/lambda-client.ts and
  // deployment-engine.ts's deployDynamicApp().
  //
  // One shared ECR repo for every dynamic app's image, e.g.
  // 123456789012.dkr.ecr.ap-south-1.amazonaws.com/dreamer-dynamic-apps -
  // build-engine's Kaniko step pushes here, tagged `{repo}:{projectSlug}`.
  ECR_REPOSITORY_URI: z.string().optional(),
  // The IAM role every deployed Lambda function assumes at runtime - needs
  // only AWSLambdaBasicExecutionRole (CloudWatch Logs) unless a user's app
  // itself calls other AWS services, which this platform has no way to know
  // about, so it isn't granted here.
  LAMBDA_EXECUTION_ROLE_ARN: z.string().optional(),
  LAMBDA_ARCHITECTURE: z.enum(['x86_64', 'arm64']).default('x86_64'),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid environment variables:');
    console.error(z.treeifyError(parsed.error));
    process.exit(1);
  }

  return parsed.data;
}

// Validated ONCE, at import time. Every other file imports `env`, not `process.env`,
// so a missing/malformed variable crashes the process at boot — not three requests
// into production when someone finally hits the code path that needed it.
export const env = loadEnv();
