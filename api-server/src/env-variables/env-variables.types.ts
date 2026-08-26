import { z } from 'zod';
import type { EnvironmentTarget } from '../generated/prisma/client';

const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENVIRONMENT_TARGETS = ['PRODUCTION', 'PREVIEW', 'DEVELOPMENT'] as const;

/**
 * Names the build-engine container always receives from the platform itself
 * (deployment-engine.ts's containerOverrides.environment) — see the build
 * config guide's Part 5 risk note. A user-defined env var sharing one of
 * these names would land in the same container `environment` map as the
 * platform's own value for it, and a naive merge's behavior on
 * duplicate names is not a contract worth relying on. Rejecting the
 * collision at creation time is far cheaper to reason about than debugging
 * "why did my build get a stale AWS_REGION" after the fact.
 *
 * Prefixes, not exact names, because GIT_ACCESS_TOKEN today could become
 * GIT_ACCESS_TOKEN_V2 tomorrow — blocking the whole namespace the platform
 * operates in is more durable than maintaining an exact-match list by hand.
 */
const RESERVED_ENV_KEY_PREFIXES = ['AWS_', 'GIT_', 'REDIS_', 'DEPLOYMENT_', 'PROJECT_', 'ROOT_DIRECTORY', 'INSTALL_COMMAND', 'BUILD_COMMAND', 'OUTPUT_DIRECTORY', 'COMMIT_HASH', 'BRANCH'];

function isReservedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return RESERVED_ENV_KEY_PREFIXES.some((prefix) => upper.startsWith(prefix) || upper === prefix);
}

const envKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(ENV_KEY_REGEX, 'Must look like an environment variable name — letters, numbers, and underscores, and cannot start with a number')
  .refine((key) => !isReservedEnvKey(key), {
    message: 'This name is reserved by the platform and cannot be used for a project environment variable',
  });

export const createEnvVariableSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  body: z.object({
    key: envKeySchema,
    value: z.string().max(65536),
    environments: z.array(z.enum(ENVIRONMENT_TARGETS)).min(1, 'Select at least one environment'),
    isSecret: z.boolean().optional().default(true),
    description: z.string().max(500).trim().optional(),
  }),
});

export const listEnvVariablesQuerySchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  query: z.object({
    environment: z.enum(ENVIRONMENT_TARGETS).optional(),
  }),
});

export const envVariableIdParamSchema = z.object({
  params: z.object({ envVariableId: z.uuid() }),
});

export const updateEnvVariableSchema = z.object({
  params: z.object({ envVariableId: z.uuid() }),
  body: z.object({
    value: z.string().max(65536).optional(),
    environments: z.array(z.enum(ENVIRONMENT_TARGETS)).min(1).optional(),
    isSecret: z.boolean().optional(),
    description: z.string().max(500).trim().optional(),
  }),
});

export type CreateEnvVariableInput = z.infer<typeof createEnvVariableSchema>['body'];
export type UpdateEnvVariableInput = z.infer<typeof updateEnvVariableSchema>['body'];

export const MASKED_VALUE = '••••••••';

/** value is the decrypted plaintext ONLY when isSecret is false — see env-variables.service.ts's toPublicEnvVariable. Otherwise null; the client calls POST /:id/reveal to fetch it on demand. */
export interface PublicEnvVariable {
  id: string;
  projectId: string;
  key: string;
  value: string | null;
  maskedValue: string;
  isSecret: boolean;
  environments: EnvironmentTarget[];
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}