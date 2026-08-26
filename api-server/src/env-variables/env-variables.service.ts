import { prisma } from '../lib/prisma';
import { audit, type AuditMeta } from '../lib/audit';
import { ConflictError, NotFoundError } from '../lib/errors';
import { decryptFromColumn, encryptForColumn } from '../lib/crypto';
import { assertProjectOwnership } from '../projects/project.service';
import { MASKED_VALUE } from './env-variables.types';
import type { CreateEnvVariableInput, PublicEnvVariable, UpdateEnvVariableInput } from './env-variables.types';
import type { EnvironmentTarget, EnvVariable } from '../generated/prisma/client';

/**
 * Decrypts only when safe to show in a list — isSecret: false means the
 * value was explicitly marked safe to display, per the model's own comment
 * ("false = shown in UI, true = masked"). A genuinely secret value is never
 * decrypted here — only in revealEnvVariable() below, which is rate-limited
 * and audited specifically because it's the one path that returns a real
 * secret to the client.
 */
function toPublicEnvVariable(envVar: EnvVariable): PublicEnvVariable {
  return {
    id: envVar.id,
    projectId: envVar.projectId,
    key: envVar.key,
    value: envVar.isSecret ? null : decryptFromColumn({ value: envVar.value, iv: envVar.iv }),
    maskedValue: MASKED_VALUE,
    isSecret: envVar.isSecret,
    environments: envVar.environments,
    description: envVar.description,
    createdAt: envVar.createdAt,
    updatedAt: envVar.updatedAt,
  };
}

/**
 * EnvVariable has no userId of its own — same ownership-check pattern as
 * assertProjectOwnership/assertDeploymentOwnership, just one relation
 * further out: EnvVariable → Project → User. Scoping by userId in the WHERE
 * clause itself (not "fetch then compare") is what makes this safe against
 * IDOR — see 00-overview-and-corrections.md §4.
 */
async function findOwnedEnvVariable(envVariableId: string, userId: string): Promise<EnvVariable> {
  const envVar = await prisma.envVariable.findFirst({
    where: { id: envVariableId, project: { userId, deletedAt: null } },
  });
  if (!envVar) throw new NotFoundError('Environment variable not found', 'ENV_VARIABLE_NOT_FOUND');
  return envVar;
}

export async function listEnvVariablesForProject(
  projectId: string,
  userId: string,
  environment?: EnvironmentTarget
): Promise<PublicEnvVariable[]> {
  await assertProjectOwnership(projectId, userId);

  const envVars = await prisma.envVariable.findMany({
    where: {
      projectId,
      ...(environment ? { environments: { has: environment } } : {}),
    },
    orderBy: { key: 'asc' },
  });

  return envVars.map(toPublicEnvVariable);
}

export async function createEnvVariable(
  projectId: string,
  userId: string,
  input: CreateEnvVariableInput,
  meta: AuditMeta
): Promise<PublicEnvVariable> {
  await assertProjectOwnership(projectId, userId);

  const { value, iv } = encryptForColumn(input.value);

  try {
    const envVar = await prisma.envVariable.create({
      data: {
        projectId,
        key: input.key,
        value,
        iv,
        environments: input.environments,
        isSecret: input.isSecret,
        description: input.description,
      },
    });

    await audit(userId, 'env_variable.create', meta, {
      resourceType: 'env_variable',
      resourceId: envVar.id,
      metadata: { projectId, key: input.key }, // the KEY is fine to log — the VALUE never is
    });

    return toPublicEnvVariable(envVar);
  } catch (err) {
    // @@unique([projectId, key]) — Prisma error code P2002 on a duplicate key
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
      throw new ConflictError(
        `An environment variable named "${input.key}" already exists for this project`,
        'ENV_VARIABLE_KEY_TAKEN'
      );
    }
    throw err;
  }
}

export async function updateEnvVariable(
  envVariableId: string,
  userId: string,
  input: UpdateEnvVariableInput,
  meta: AuditMeta
): Promise<PublicEnvVariable> {
  const existing = await findOwnedEnvVariable(envVariableId, userId);

  const valuePatch = input.value !== undefined ? encryptForColumn(input.value) : undefined;

  const envVar = await prisma.envVariable.update({
    where: { id: existing.id },
    data: {
      ...(valuePatch ? { value: valuePatch.value, iv: valuePatch.iv } : {}),
      environments: input.environments,
      isSecret: input.isSecret,
      description: input.description,
    },
  });

  await audit(userId, 'env_variable.update', meta, {
    resourceType: 'env_variable',
    resourceId: envVar.id,
    metadata: { projectId: envVar.projectId, key: envVar.key, valueChanged: Boolean(valuePatch) },
  });

  return toPublicEnvVariable(envVar);
}

export async function deleteEnvVariable(envVariableId: string, userId: string, meta: AuditMeta): Promise<void> {
  const existing = await findOwnedEnvVariable(envVariableId, userId);

  await prisma.envVariable.delete({ where: { id: existing.id } });

  await audit(userId, 'env_variable.delete', meta, {
    resourceType: 'env_variable',
    resourceId: existing.id,
    metadata: { projectId: existing.projectId, key: existing.key },
  });
}

/**
 * The one path that ever returns a real secret value to the client.
 * Rate-limited at the route level (env-variables.routes.ts) and audited
 * here — "who revealed which secret, and when" is exactly the kind of
 * question an audit log exists to answer.
 */
export async function revealEnvVariable(
  envVariableId: string,
  userId: string,
  meta: AuditMeta
): Promise<{ value: string }> {
  const existing = await findOwnedEnvVariable(envVariableId, userId);

  const value = decryptFromColumn({ value: existing.value, iv: existing.iv });

  await audit(userId, 'env_variable.reveal', meta, {
    resourceType: 'env_variable',
    resourceId: existing.id,
    metadata: { projectId: existing.projectId, key: existing.key },
  });

  return { value };
}