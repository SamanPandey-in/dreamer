import { z } from 'zod';
import type { EnvironmentTarget } from '../generated/prisma/client';

const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENVIRONMENT_TARGETS = ['PRODUCTION', 'PREVIEW', 'DEVELOPMENT'] as const;

export const createEnvVariableSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  body: z.object({
    key: z
      .string()
      .min(1)
      .max(255)
      .regex(ENV_KEY_REGEX, 'Must look like an environment variable name — letters, numbers, and underscores, and cannot start with a number'),
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