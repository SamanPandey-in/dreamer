import { generateSlug } from 'random-word-slugs';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { audit, type AuditMeta } from '../lib/audit';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors';
import { decryptFromColumn, decryptFromStorage } from '../lib/crypto';
import { deleteS3Prefix } from '../lib/s3-client';
import { assertProjectOwnership } from '../projects/project.service'; // concrete file, not the barrel — see §0.5
import { deploymentEngine } from './deployment-engine';
import { buildQueue } from '../lib/queue';
import { logger } from '../lib/logger';
import type {
  CreateDeploymentInput,
  DeploymentDetail,
  PublicDeployment,
  PublicLogLine,
} from './deployment.types';
import type { DeploymentImageReadyEvent } from '../realtime/realtime.types';
import type { Deployment, DeploymentLog, DeploymentStatus, EnvironmentTarget, Prisma } from '../generated/prisma/client';

const SLUG_MAX_ATTEMPTS = 5;

/** Statuses where a build is still in flight — used by the frontend to decide whether to open a socket at all. */
export const ACTIVE_STATUSES: DeploymentStatus[] = ['QUEUED', 'BUILDING', 'UPLOADING', 'STARTING'];
export const TERMINAL_STATUSES: DeploymentStatus[] = ['RUNNING', 'STOPPED', 'FAILED', 'CANCELLED'];

/**
 *  NEW. Distinct from TERMINAL_STATUSES above on purpose — that one answers
 * "will any more realtime events ever arrive" (RUNNING counts as terminal
 * there; the build is over). This one answers "can the Stop button still do
 * anything" — and RUNNING very much can: it's the live site.
 */
export const NON_STOPPABLE_STATUSES: DeploymentStatus[] = ['STOPPED', 'FAILED', 'CANCELLED'];

/**  NEW. Build states where the ECS task itself is still alive and killable via stopBuildTask. */
const IN_FLIGHT_BUILD_STATUSES: DeploymentStatus[] = ['BUILDING', 'UPLOADING', 'STARTING'];

/**  NEW. A rollback target must have actually finished — rolling back TO a FAILED or still-QUEUED row would just reproduce whatever didn't work. */
const ROLLBACK_TARGET_STATUSES: DeploymentStatus[] = ['RUNNING', 'STOPPED'];

function toPublicDeployment(deployment: Deployment): PublicDeployment {
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    slug: deployment.slug,
    status: deployment.status,
    type: deployment.type,
    framework: deployment.framework,
    environment: deployment.environment,
    branch: deployment.branch,
    commitHash: deployment.commitHash,
    commitMessage: deployment.commitMessage,
    commitAuthor: deployment.commitAuthor,
    deployedById: deployment.deployedById,
    url: deployment.url,
    errorMessage: deployment.errorMessage,
    errorCode: deployment.errorCode,
    errorStep: deployment.errorStep,
    buildDurationMs: deployment.buildDurationMs,
    uploadedFileCount: deployment.uploadedFileCount,
    imageSizeBytes: deployment.imageSizeBytes,
    triggeredBy: deployment.triggeredBy,
    queuedAt: deployment.queuedAt,
    buildStartedAt: deployment.buildStartedAt,
    buildFinishedAt: deployment.buildFinishedAt,
    deployedAt: deployment.deployedAt,
    stoppedAt: deployment.stoppedAt,
    createdAt: deployment.createdAt,
  };
}

function toPublicLogLine(log: DeploymentLog): PublicLogLine {
  return {
    id: log.id.toString(), // bigint -> string, see the PublicLogLine comment in deployment.types.ts
    level: log.level,
    message: log.message,
    sequence: log.sequence,
    source: log.source,
    timestamp: log.timestamp,
  };
}

/**
 * Deployment.slug is still `@unique` and generated independently here — but
 * it no longer drives the S3 prefix or the live subdomain. That's
 * project.slug now (see createDeployment below, and project.service.ts's
 * name-derived slug generation). This survives purely as a per-deployment
 * internal label, useful in logs/history ("deployment fuzzy-cat-42
 * failed"), deliberately decoupled from anything user-facing.
 */
async function generateUniqueDeploymentSlug(): Promise<string> {
  for (let attempt = 0; attempt < SLUG_MAX_ATTEMPTS; attempt++) {
    const candidate = generateSlug();
    const existing = await prisma.deployment.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
  }
  throw new ConflictError(
    'Could not generate a unique deployment slug — please try again',
    'SLUG_GENERATION_FAILED'
  );
}

export async function assertDeploymentOwnership(deploymentId: string, userId: string) {
  const deployment = await prisma.deployment.findFirst({
    where: { id: deploymentId, project: { userId, deletedAt: null } },
    include: { stateTransitions: { orderBy: { createdAt: 'asc' } } },
  });
  if (!deployment) throw new NotFoundError('Deployment not found', 'DEPLOYMENT_NOT_FOUND');
  return deployment;
}

/**
 * Fetches every EnvVariable scoped to `environment` for a project and
 * decrypts each one — the one place outside env-variables.service.ts that
 * ever decrypts a real secret value, and it does so for exactly the reason
 * env-variables.service.ts's own revealEnvVariable() does: the build
 * actually needs the plaintext, not the masked placeholder. Unlike reveal(),
 * this is never user-triggered and never returns the value to any client —
 * it goes straight into the ECS task's container environment
 * (deployment-engine.ts) and nowhere else.
 *
 * RESERVED_ENV_KEY_PREFIXES (env-variables.types.ts) already rejects a
 * colliding key at CREATE time, so by the time a row reaches this query
 * it's guaranteed safe to merge into the same environment array as the
 * platform's own AWS, GIT, and build-config vars.
 */
async function resolveProjectEnvVarsForEnvironment(
  projectId: string,
  environment: EnvironmentTarget
): Promise<Array<{ name: string; value: string }>> {
  const envVars = await prisma.envVariable.findMany({
    where: { projectId, environments: { has: environment } },
  });

  return envVars.map((envVar) => ({
    name: envVar.key,
    value: decryptFromColumn({ value: envVar.value, iv: envVar.iv }),
  }));
}

/**
 *  NEW (refactor). The shared body of "create a Deployment row and launch
 * it" — both createDeployment (public API: branch only) and
 * rollbackDeployment (internal: branch + a pinned commitHash) call this, so
 * the transaction/audit/ECS-launch logic exists exactly once.
 */
interface CreateDeploymentOptions {
  branch?: string;
  /** Only ever set by rollbackDeployment. */
  commitHash?: string;
  triggeredBy: string; // 'manual' | 'api' | 'rollback' | (future) 'webhook'
}

async function createDeploymentInternal(
  projectId: string,
  userId: string,
  opts: CreateDeploymentOptions,
  meta: AuditMeta
): Promise<PublicDeployment> {
  const project = await assertProjectOwnership(projectId, userId);

  let gitAccessToken: string | undefined;
  if (project.isPrivate) {
    const owner = await prisma.user.findUnique({ where: { id: userId }, select: { githubToken: true } });
    if (!owner?.githubToken) {
      throw new BadRequestError(
        'Connect your GitHub account before deploying a private repository',
        'GITHUB_NOT_CONNECTED'
      );
    }
    gitAccessToken = decryptFromStorage(owner.githubToken);
  }

  const branch = opts.branch ?? project.defaultBranch;
  const slug = await generateUniqueDeploymentSlug();
  const environment: 'PRODUCTION' | 'PREVIEW' = branch === project.defaultBranch ? 'PRODUCTION' : 'PREVIEW';

  // NEW — resolved once per deploy, not per build-engine invocation. Reading
  // env vars here (rather than inside deployment-engine.ts) keeps
  // EcsDeploymentEngine free of any direct Prisma/crypto dependency — it
  // stays a pure "take a BuildJob, talk to ECS" abstraction, which is also
  // exactly what made it swappable behind the DeploymentEngine interface in
  // the first place.
  const userEnvVars = await resolveProjectEnvVarsForEnvironment(projectId, environment);
  const deployment = await prisma.$transaction(async (tx) => {
    const created = await tx.deployment.create({
      data: {
        projectId,
        slug,
        branch,
        environment,
        deployedById: userId,
        triggeredBy: opts.triggeredBy,
        status: 'QUEUED',
        s3Prefix: `__outputs/${project.slug}/`,
        commitHash: opts.commitHash,
        // NEW — copied from the project's own detection result (set once,
        // at project-creation time, by the wizard — see project.service.ts's
        // createProject) rather than re-detected on every deploy. A redeploy
        // of an existing project doesn't re-fetch package.json from GitHub
        // just to label itself; it inherits what the project was already
        // determined to be.
        type: project.detectedDeploymentType,
        framework: project.detectedFramework,
      },
    });

    await tx.deploymentStateTransition.create({
      data: {
        deploymentId: created.id,
        fromStatus: null,
        toStatus: 'QUEUED',
        reason: opts.commitHash ? 'Rollback deployment created' : 'Deployment created',
        triggeredBy: 'api',
      },
    });

    return created;
  });

  await audit(userId, 'deployment.create', meta, { resourceType: 'deployment', resourceId: deployment.id });

  try {
    // Actually launching the ECS task now happens in src/workers/build.worker.ts,
    // not here — this just hands the job off to BullMQ/Redis, which is fast
    // and doesn't depend on AWS being responsive. jobId: deployment.id means
    // a duplicate enqueue for the same deployment (e.g. a caller retrying a
    // timed-out request) is a no-op rather than a second ECS task.
    await buildQueue.add(
      'launch-build',
      {
      deploymentId: deployment.id,
      projectSlug: project.slug,
      projectId,
      repoUrl: project.repoUrl,
      branch,
      commitHash: opts.commitHash,
      gitAccessToken,
      // NEW — the project's resolved build config, read straight off the
      // row assertProjectOwnership already fetched above. null on any
      // field is a legitimate, common case (a project whose config was
      // never set, or never edited from Settings) — deployment-engine.ts
      // forwards null through as an empty string, and build-engine's
      // script.js falls back to its own hardcoded default for that field.
      rootDirectory: project.rootDirectory,
      installCommand: project.installCommand,
      buildCommand: project.buildCommand,
      outputDirectory: project.outputDirectory,
      userEnvVars,
      // NEW — see BuildJob's comment in deployment-engine.ts: this is what
      // actually decides which branch of build-engine's script.js runs.
      deploymentType: project.detectedDeploymentType,
      framework: project.detectedFramework,
      },
      { jobId: deployment.id }
    );

    return toPublicDeployment(deployment);
  } catch (err) {
    // Only reachable if Redis itself is unavailable — nothing will ever pick
    // this job up, so fail the deployment immediately rather than leaving it
    // stuck at QUEUED forever.
    const failed = await transitionDeploymentStatus(deployment.id, 'FAILED', {
      reason: 'Failed to enqueue build job',
      errorCode: 'QUEUE_ENQUEUE_FAILED',
      errorMessage: err instanceof Error ? err.message : 'Unknown queue error',
      triggeredBy: 'api',
    });
    return toPublicDeployment(failed ?? deployment);
  }
}

export async function createDeployment(
  projectId: string,
  userId: string,
  input: CreateDeploymentInput,
  meta: AuditMeta
): Promise<PublicDeployment> {
  return createDeploymentInternal(projectId, userId, { branch: input.branch, triggeredBy: 'manual' }, meta);
}

/**
 *  NEW. "Roll back" = rebuild the exact commit the target deployment ran,
 * as a brand-new Deployment row — not a copy of the old row's id/slug/AWS
 * handles, and not a re-point of traffic at old build output. Nothing keeps
 * a per-deployment artifact cache around to re-point at (every deploy
 * overwrites the same project-scoped S3 prefix — see s3Prefix's comment in
 * schema.prisma), so this is the same thing Vercel's own rollback does for
 * any provider that doesn't keep a full build-artifact cache per deployment
 * indefinitely: rebuild, from the known-good commit, right now.
 */
export async function rollbackDeployment(
  deploymentId: string,
  userId: string,
  meta: AuditMeta
): Promise<PublicDeployment> {
  const target = await assertDeploymentOwnership(deploymentId, userId);

  if (!ROLLBACK_TARGET_STATUSES.includes(target.status)) {
    throw new BadRequestError(
      'Can only roll back to a deployment that previously ran successfully',
      'INVALID_ROLLBACK_TARGET'
    );
  }

  if (!target.commitHash) {
    throw new BadRequestError(
      'This deployment has no recorded commit to roll back to',
      'ROLLBACK_COMMIT_UNKNOWN'
    );
  }

  const created = await createDeploymentInternal(
    target.projectId,
    userId,
    { branch: target.branch, commitHash: target.commitHash, triggeredBy: 'rollback' },
    meta
  );

  await audit(userId, 'deployment.rollback', meta, {
    resourceType: 'deployment',
    resourceId: created.id,
    metadata: { rolledBackFromDeploymentId: deploymentId },
  });

  return created;
}

/**
 *  NEW. See Part 1 §3b for the DB trigger this respects: STOPPED is only a
 * legal target from BUILDING/UPLOADING/STARTING/RUNNING (after the trigger
 * extension) — QUEUED routes to the pre-existing CANCELLED instead, and the
 * three terminal statuses are rejected before any transition is attempted.
 */
export async function stopDeployment(
  deploymentId: string,
  userId: string,
  meta: AuditMeta
): Promise<PublicDeployment> {
  const deployment = await assertDeploymentOwnership(deploymentId, userId);

  if (NON_STOPPABLE_STATUSES.includes(deployment.status)) {
    throw new ConflictError(
      `Cannot stop a deployment that is already ${deployment.status.toLowerCase()}`,
      'DEPLOYMENT_NOT_STOPPABLE'
    );
  }

  if (deployment.status === 'QUEUED') {
    // Best-effort: if the worker has already moved this job to 'active' this
    // is a no-op (BullMQ only removes jobs still waiting/delayed) — that's
    // fine, the worker's own launchBuildTask result will land on a
    // deployment row that's already CANCELLED, which is a rare, harmless
    // race rather than something this needs to be watertight against.
    try {
      await buildQueue.remove(deploymentId);
    } catch (err) {
      logger.error('Failed to remove queued build job', { deploymentId, err });
    }

    const updated = await transitionDeploymentStatus(deploymentId, 'CANCELLED', {
      reason: 'Cancelled by user before the build started',
      triggeredBy: 'user',
    });
    await audit(userId, 'deployment.cancel', meta, { resourceType: 'deployment', resourceId: deploymentId });
    return toPublicDeployment(updated ?? deployment);
  }

  if (IN_FLIGHT_BUILD_STATUSES.includes(deployment.status) && deployment.ecsTaskArn) {
    try {
      await deploymentEngine.stopBuildTask(deployment.ecsTaskArn);
    } catch (err) {
      // The task may have already exited on its own a moment before this
      // call landed — proceed to mark the row STOPPED regardless; don't
      // leave it stuck mid-flight in the DB just because ECS's view and
      // ours raced.
      logger.error('ECS StopTask failed', { deploymentId, err });
    }
  } else if (deployment.status === 'RUNNING') {
    // Whichever type this is, "stopping" a RUNNING deployment only makes
    // sense if it's the one the project is CURRENTLY serving — both types
    // share one live slot per project (STATIC's one S3 prefix, DYNAMIC's
    // one Lambda function — see lambdaFunctionName's comment), so stopping
    // an old, already-superseded RUNNING row must never touch whatever the
    // project is serving right now.
    const project = await prisma.project.findUnique({
      where: { id: deployment.projectId },
      select: { slug: true, activeDeploymentId: true },
    });

    if (project?.activeDeploymentId === deploymentId) {
      if (deployment.type === 'DYNAMIC') {
        // Falls back to re-deriving the name from the project slug for a
        // row that predates lambdaFunctionName being populated (shouldn't
        // happen post-migration, but costs nothing to be defensive about —
        // same instinct as the STATIC branch's `?? __outputs/{slug}/` fallback).
        const functionName = deployment.lambdaFunctionName ?? `dreamer-${project.slug}`;
        try {
          await deploymentEngine.stopDynamicApp(functionName);
        } catch (err) {
          // Same reasoning as the BUILDING/UPLOADING/STARTING branch above:
          // don't leave the row stuck RUNNING in the DB just because AWS's
          // view and ours raced or the function was already gone.
          logger.error('Lambda teardown failed', { deploymentId, err });
        }
      } else {
        try {
          await deleteS3Prefix(deployment.s3Prefix ?? `__outputs/${project.slug}/`);
        } catch (err) {
          logger.error('S3 cleanup failed', { deploymentId, err });
        }
      }
      await prisma.project.update({ where: { id: deployment.projectId }, data: { activeDeploymentId: null } });
    }
  }

  const updated = await transitionDeploymentStatus(deploymentId, 'STOPPED', {
    reason: 'Stopped by user',
    triggeredBy: 'user',
  });

  await audit(userId, 'deployment.stop', meta, { resourceType: 'deployment', resourceId: deploymentId });

  return toPublicDeployment(updated ?? deployment);
}

export async function listDeploymentsForProject(
  projectId: string,
  userId: string,
  {
    cursor,
    limit,
    branch,
    status,
    environment,
    dateFrom,
    dateTo,
  }: {
    cursor?: string;
    limit: number;
    branch?: string;
    status?: DeploymentStatus;
    environment?: 'PRODUCTION' | 'PREVIEW';
    dateFrom?: Date;
    dateTo?: Date;
  }
): Promise<{ deployments: PublicDeployment[]; nextCursor: string | null }> {
  await assertProjectOwnership(projectId, userId);

  const rows = await prisma.deployment.findMany({
    where: {
      projectId,
      ...(branch ? { branch } : {}),
      ...(status ? { status } : {}),
      ...(environment ? { environment } : {}),
      ...(dateFrom || dateTo
        ? { createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    deployments: page.map(toPublicDeployment),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

export async function getDeploymentDetail(deploymentId: string, userId: string): Promise<DeploymentDetail> {
  const deployment = await assertDeploymentOwnership(deploymentId, userId);

  return {
    ...toPublicDeployment(deployment),
    stateTransitions: deployment.stateTransitions.map((transition) => ({
      id: transition.id,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      reason: transition.reason,
      createdAt: transition.createdAt,
    })),
  };
}

export async function listDeploymentLogs(
  deploymentId: string,
  userId: string,
  { after, limit }: { after: number; limit: number }
): Promise<PublicLogLine[]> {
  await assertDeploymentOwnership(deploymentId, userId);

  const logs = await prisma.deploymentLog.findMany({
    where: { deploymentId, sequence: { gt: after } },
    orderBy: { sequence: 'asc' },
    take: limit,
  });

  return logs.map(toPublicLogLine);
}

export interface TransitionOptions {
  reason?: string;
  errorCode?: string;
  errorMessage?: string;
  errorStep?: string;
  url?: string;
  triggeredBy?: string;
  metadata?: Prisma.InputJsonValue;
  uploadedFileCount?: number; //  NEW
}

export async function transitionDeploymentStatus(
  deploymentId: string,
  toStatus: DeploymentStatus,
  opts: TransitionOptions = {}
): Promise<Deployment | null> {
  const current = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!current) return null;

  const now = new Date();
  const timestampPatch: Prisma.DeploymentUpdateInput = {};

  if (toStatus === 'BUILDING' && !current.buildStartedAt) timestampPatch.buildStartedAt = now;

  if ((toStatus === 'UPLOADING' || toStatus === 'STARTING') && !current.buildFinishedAt) {
    timestampPatch.buildFinishedAt = now;
    if (current.buildStartedAt) {
      timestampPatch.buildDurationMs = now.getTime() - current.buildStartedAt.getTime();
    }
  }

  if (toStatus === 'RUNNING' && !current.deployedAt) timestampPatch.deployedAt = now;
  if (toStatus === 'STOPPED' || toStatus === 'FAILED' || toStatus === 'CANCELLED') {
    timestampPatch.stoppedAt = now;
  }

  const updated = await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      status: toStatus,
      url: opts.url,
      errorMessage: opts.errorMessage,
      errorCode: opts.errorCode,
      errorStep: opts.errorStep,
      uploadedFileCount: opts.uploadedFileCount, //  NEW
      ...timestampPatch,
    },
  });

  await prisma.deploymentStateTransition.create({
    data: {
      deploymentId,
      fromStatus: current.status,
      toStatus,
      reason: opts.reason,
      triggeredBy: opts.triggeredBy ?? 'build-engine',
      metadata: opts.metadata,
    },
  });

  if (toStatus === 'RUNNING') {
    await prisma.project.update({
      where: { id: updated.projectId },
      data: { activeDeploymentId: deploymentId, lastDeployedAt: now },
    });
  }

  return updated;
}

/**
 *  NEW. The only function that writes commitHash/commitMessage/commitAuthor
 * — same single-writer discipline as transitionDeploymentStatus above, kept
 * SEPARATE from it (not folded in) because this isn't a status change:
 * build-engine reports commit info once, early, independent of whatever
 * status transitions happen around it. Called from realtime/log-relay.ts
 * when a `commit_info` event arrives.
 */
export interface CommitInfo {
  commitHash: string;
  commitMessage?: string;
  commitAuthor?: string;
}

export async function recordCommitInfo(deploymentId: string, info: CommitInfo): Promise<void> {
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      commitHash: info.commitHash,
      commitMessage: info.commitMessage,
      commitAuthor: info.commitAuthor,
    },
  });
}

/**
 * NEW: the dynamic hand-off point - called from log-relay.ts when 
 * build-engine's Kaniko step publishes `image_ready` (see realtime.types.ts).
 * Turns a pushed container image into a live, publically invokable Lambda function
 * via deploymentEngine.deployDynamicApp() then transitions the deployment to RUNNING - or FAILED,
 * symmetric wiht how a LaunchBuildTask failure is handled in createDeploymentInternal above.
 * 
 * Runs AFTER build-engine's own task has already exited (kaniko's push was its last step) - this 
 * is why Lambda CreateFunction/UpdateFunctionCode work happens over here, in api-server, 
 * rather than in build-enigne itself: build-engine's IAM role only ever needed ECR push 
 * permissions (see * env.ts's comment on ECR_REPOSITORY_URI), never Lambda permissions.
 */
export async function handleImageReady(
  deploymentId: string,
  event: DeploymentImageReadyEvent
): Promise<Deployment | null> {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!deployment) return null;

  // Persist the pushed image URI immediately, independent of whether the
  // Lambda deploy that follows succeeds — if deployDynamicApp throws below,
  // a retried/rolled-back deploy (or a human debugging in the dashboard)
  // still sees exactly which image was built, not a blank column.
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { ecrImageUri: event.ecrImageUri, imageSizeBytes: event.imageSizeBytes },
  });

  await transitionDeploymentStatus(deploymentId, 'STARTING', {
    reason: 'Image pushed to ECR — creating Lambda function',
    triggeredBy: 'build-engine',
  });

  const project = await prisma.project.findUnique({
    where: { id: deployment.projectId },
    select: { slug: true },
  });
  if (!project) {
    return transitionDeploymentStatus(deploymentId, 'FAILED', {
      reason: 'Project no longer exists',
      errorCode: 'PROJECT_NOT_FOUND',
      errorStep: 'start',
      triggeredBy: 'api',
    });
  }

  try {
    // Re-resolved here rather than threaded through from createDeploymentInternal
    // — this runs minutes later, in a completely separate async hop
    // (Redis pub/sub -> log-relay), so there's no in-memory value to reuse;
    // same reasoning as why launchBuildTask resolves them fresh too.
    const userEnvVars = await resolveProjectEnvVarsForEnvironment(deployment.projectId, deployment.environment);

    const handle = await deploymentEngine.deployDynamicApp({
      deploymentId,
      projectSlug: project.slug,
      ecrImageUri: event.ecrImageUri,
      userEnvVars,
    });

    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        lambdaFunctionArn: handle.lambdaFunctionArn,
        lambdaFunctionName: handle.lambdaFunctionName,
        lambdaFunctionUrl: handle.lambdaFunctionUrl,
      },
    });

    return await transitionDeploymentStatus(deploymentId, 'RUNNING', {
      url: event.url,
      triggeredBy: 'build-engine',
    });
  } catch (err) {
    return await transitionDeploymentStatus(deploymentId, 'FAILED', {
      reason: 'Failed to deploy Lambda function',
      errorCode: 'LAMBDA_DEPLOY_FAILED',
      errorMessage: err instanceof Error ? err.message : 'Unknown Lambda deploy error',
      errorStep: 'start',
      triggeredBy: 'api',
    });
  }
}

export async function appendLogLine(
  deploymentId: string,
  line: { level: DeploymentLog['level']; message: string; source?: string }
): Promise<PublicLogLine> {
  const sequenceKey = `deploy:seq:${deploymentId}`;
  const sequence = await redis.incr(sequenceKey);
  await redis.expire(sequenceKey, 60 * 60 * 24 * 7);

  const log = await prisma.deploymentLog.create({
    data: { deploymentId, level: line.level, message: line.message, source: line.source, sequence },
  });

  return toPublicLogLine(log);
}
