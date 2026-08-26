import { generateSlug } from 'random-word-slugs';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { audit, type AuditMeta } from '../lib/audit';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors';
import { decryptFromColumn } from '../lib/crypto';
import { getSingleOperatorGitAccessToken } from '../lib/git-credentials';
import { deleteS3Prefix } from '../lib/s3-client';
import { assertProjectOwnership } from '../projects/project.service'; // concrete file, not the barrel — see §0.5
import { deploymentEngine } from './deployment-engine';
import { buildQueue } from '../lib/queue';
import { logger } from '../lib/logger';
import { invalidateRouteCache } from '../lib/route-cache';
import { ensureConsumerRunning, ensureConsumerStopped } from '../realtime/consumer-lifecycle';
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
export const ACTIVE_STATUSES: DeploymentStatus[] = ['QUEUED', 'LAUNCHING', 'BUILDING', 'UPLOADING', 'STARTING'];
export const TERMINAL_STATUSES: DeploymentStatus[] = ['RUNNING', 'STOPPED', 'FAILED', 'CANCELLED'];

/**
 *  NEW. Distinct from TERMINAL_STATUSES above on purpose — that one answers
 * "will any more realtime events ever arrive" (RUNNING counts as terminal
 * there; the build is over). This one answers "can the Stop button still do
 * anything" — and RUNNING very much can: it's the live site.
 */
export const NON_STOPPABLE_STATUSES: DeploymentStatus[] = ['STOPPED', 'FAILED', 'CANCELLED'];

/**  NEW. Build states where the build container itself is still alive and killable via stopBuildTask. */
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
 * it goes straight into the build container's own environment
 * (deployment-engine.ts) and nowhere else.
 *
 * RESERVED_ENV_KEY_PREFIXES (env-variables.types.ts) already rejects a
 * colliding key at CREATE time, so by the time a row reaches this query
 * it's guaranteed safe to merge into the same environment array as the
 * platform's own MinIO, GIT, and build-config vars.
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
 * the transaction/audit/build-launch logic exists exactly once.
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

  // SECURITY — deliberately not writing an actual access token into the job
  // below: BullMQ job data is written verbatim into Redis and kept around
  // for up to 500 completed / 1,000 failed jobs (see lib/queue.ts) —
  // nothing bearer-credential-shaped belongs in it. This just fails fast,
  // with a clear error, if a private-repo deploy is requested with no PAT
  // configured at all — build.worker.ts decrypts the PAT itself
  // (lib/git-credentials.ts), immediately before the docker run call that
  // needs it, and it's never written back into the job. See
  // docs/architecture/local-engine-auth-and-networking.md Decision 2.
  if (project.isPrivate) {
    const gitAccessToken = await getSingleOperatorGitAccessToken();
    if (!gitAccessToken) {
      throw new BadRequestError(
        'Set a git Personal Access Token in Settings before deploying a private repository',
        'GIT_TOKEN_NOT_CONFIGURED'
      );
    }
  }

  const branch = opts.branch ?? project.defaultBranch;
  const slug = await generateUniqueDeploymentSlug();
  const environment: 'PRODUCTION' | 'PREVIEW' = branch === project.defaultBranch ? 'PRODUCTION' : 'PREVIEW';

  // Resolved once per deploy, not per build-engine invocation. Reading
  // env vars here (rather than inside deployment-engine.ts) keeps
  // DockerDeploymentEngine free of any direct Prisma/crypto dependency — it
  // stays a pure "take a BuildJob, talk to Docker" abstraction.
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
        outputPrefix: `__outputs/${project.slug}/`,
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

  // NEW — starts log-relay.ts's Redis Stream consumer (if it isn't
  // already running) the instant this deployment is queued, in THIS same
  // request, rather than waiting up to LOG_RELAY_RECONCILE_INTERVAL_MS for
  // the periodic reconciliation below to notice. See consumer-lifecycle.ts's
  // own comment for the full design — this is the primary trigger, that
  // reconciliation is the safety net.
  ensureConsumerRunning();

  try {
    // Actually launching the build container now happens in src/workers/build.worker.ts,
    // not here — this just hands the job off to BullMQ/Redis, which is fast
    // and doesn't depend on MinIO being responsive. jobId: deployment.id means
    // a duplicate enqueue for the same deployment (e.g. a caller retrying a
    // timed-out request) is a no-op rather than a second build container.
    await buildQueue.add(
      'launch-build',
      {
        deploymentId: deployment.id,
        projectSlug: project.slug,
        projectId,
        // The worker decrypts the operator's PAT itself (see
        // build.worker.ts) using isPrivate alone; no secret travels through
        // the job payload. See the SECURITY comment above.
        isPrivate: project.isPrivate,
        repoUrl: project.repoUrl,
        branch,
        commitHash: opts.commitHash,
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

// FIX — "queued but never consumed" recovery. createDeploymentInternal
// above writes the Deployment row as QUEUED and THEN calls buildQueue.add;
// the only thing that flips status away from QUEUED again is
// build.worker.ts's processor actually picking the job up (see its atomic
// UPDATE ... WHERE status = 'QUEUED' claim). If the enqueue call itself
// never reaches BullMQ — a Redis blip between the DB write and the
// buildQueue.add call, a process restart mid-request, anything that isn't
// a clean thrown-and-caught error — the row is left stuck at QUEUED
// forever with no job in Redis to ever pick it up, and no error anywhere
// to explain why. This has no way to distinguish itself from "queued and
// legitimately waiting behind CONCURRENCY other jobs," which is exactly
// why it's a periodic reconciliation rather than a tighter timeout: a job
// that DOES have a BullMQ entry is left alone no matter how old it is.
//
// STALE_QUEUE_GRACE_MS gives a normal enqueue (DB write -> buildQueue.add,
// same request) room to finish before this is allowed to touch a row —
// this only ever acts on rows old enough that a normal enqueue would long
// since have completed.
const STALE_QUEUE_GRACE_MS = 2 * 60 * 1000; // 2 minutes

export async function reconcileOrphanedQueuedDeployments(): Promise<void> {
  const staleQueued = await prisma.deployment.findMany({
    where: { status: 'QUEUED', createdAt: { lt: new Date(Date.now() - STALE_QUEUE_GRACE_MS) } },
    include: { project: true },
  });

  if (staleQueued.length === 0) return;

  for (const deployment of staleQueued) {
    try {
      const existingJob = await buildQueue.getJob(deployment.id);
      if (existingJob) continue; // genuinely just waiting its turn — leave it alone

      const project = deployment.project;
      if (!project || project.deletedAt) {
        // Project was deleted after this deployment was queued — nothing
        // sane to re-launch; leave the row as-is for the audit trail.
        continue;
      }

      logger.warn('Re-enqueuing a QUEUED deployment with no corresponding job in the build queue', {
        deploymentId: deployment.id,
        projectId: project.id,
        queuedForMs: Date.now() - deployment.createdAt.getTime(),
      });

      const environment = deployment.environment;
      const userEnvVars = await resolveProjectEnvVarsForEnvironment(project.id, environment);

      await buildQueue.add(
        'launch-build',
        {
          deploymentId: deployment.id,
          projectSlug: project.slug,
          projectId: project.id,
          isPrivate: project.isPrivate,
          repoUrl: project.repoUrl,
          branch: deployment.branch ?? project.defaultBranch,
          commitHash: deployment.commitHash ?? undefined,
          rootDirectory: project.rootDirectory,
          installCommand: project.installCommand,
          buildCommand: project.buildCommand,
          outputDirectory: project.outputDirectory,
          userEnvVars,
          deploymentType: project.detectedDeploymentType,
          framework: project.detectedFramework,
        },
        { jobId: deployment.id }
      );
    } catch (err) {
      // Never let one bad row stop the rest of the sweep, and never let this
      // background job crash the process it's running in.
      logger.error('Failed to re-enqueue an orphaned QUEUED deployment', { deploymentId: deployment.id, err });
    }
  }
}

// NEW — every status a deployment can be in WHILE log-relay.ts's Redis
// Stream consumer should be actively polling for events about it. Terminal
// statuses (RUNNING, STOPPED, FAILED, CANCELLED, ERROR) are the complement:
// nothing further will ever arrive on the stream for a deployment once it
// reaches one of those, so a deployment sitting in one of THOSE contributes
// nothing to whether polling should be running. SLEEPING/WAKING included
// defensively even though nothing in this codebase sets them today (see
// their own dead-code note on the DeploymentStatus enum in schema.prisma)
// — costs nothing to include, and avoids silently breaking this the day
// scale-to-zero actually gets built.
const LOG_RELAY_ACTIVE_STATUSES: DeploymentStatus[] = [
  'QUEUED', 'LAUNCHING', 'BUILDING', 'UPLOADING', 'STARTING', 'SLEEPING', 'WAKING',
];

/**
 * The safety net for consumer-lifecycle.ts's start/stop gating — see that
 * file's own comment for the full design and why this specifically reads
 * Postgres (never Redis) to decide. Two jobs, both cheap and idempotent:
 * (1) catch a process restart that landed while some OTHER deployment
 * (created by an earlier boot of this process, or — if api-server is ever
 * scaled to multiple replicas — by a different one) is still mid-flight,
 * since ensureConsumerRunning()'s instant-start only fires in the request
 * that CREATES a deployment, not on every subsequent restart; (2)
 * eventually stop polling once genuinely nothing is active anywhere,
 * bounded by however often src/index.ts calls this.
 */
export async function reconcileLogRelayActivity(): Promise<void> {
  const activeCount = await prisma.deployment.count({ where: { status: { in: LOG_RELAY_ACTIVE_STATUSES } } });
  if (activeCount > 0) {
    ensureConsumerRunning();
  } else {
    ensureConsumerStopped();
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
 * Called exclusively from webhooks/github-webhook.service.ts once a push to
 * a project's production branch has passed every skip check
 * (autoDeployEnabled, branch match, no build already in flight — see
 * ACTIVE_STATUSES above). `ownerId` is always the PROJECT OWNER's id here,
 * not a request-authenticated caller — there's no logged-in user on a
 * webhook delivery, so the caller resolves it from the project row itself.
 *
 * commitHash is always set, always payload.after from the push event —
 * passing it pins the build to the EXACT pushed commit, never a re-fetched
 * branch HEAD that could have moved again by the time the build starts
 * (same mechanism rollbackDeployment already uses to pin a rebuild).
 */
export async function createWebhookDeployment(
  projectId: string,
  ownerId: string,
  input: { branch: string; commitHash: string },
  meta: AuditMeta
): Promise<PublicDeployment> {
  return createDeploymentInternal(
    projectId,
    ownerId,
    { branch: input.branch, commitHash: input.commitHash, triggeredBy: 'webhook' },
    meta
  );
}

/**
 * Used by webhooks/github-webhook.service.ts's "already building" skip
 * check — a second push landing while the first push's build is still in
 * flight is logged and dropped, not queued on top of it: both builds would
 * race to write the same project-scoped output prefix / app container.
 */
export async function hasActiveDeployment(projectId: string): Promise<boolean> {
  const active = await prisma.deployment.findFirst({
    where: { projectId, status: { in: ACTIVE_STATUSES } },
    select: { id: true },
  });
  return active !== null;
}

/**
 *  NEW. "Roll back" = rebuild the exact commit the target deployment ran,
 * as a brand-new Deployment row — not a copy of the old row's id/slug/engine
 * handles, and not a re-point of traffic at old build output. Nothing keeps
 * a per-deployment artifact cache around to re-point at (every deploy
 * overwrites the same project-scoped output prefix — see outputPrefix's
 * comment in schema.prisma), so this is the same thing Vercel's own
 * rollback does for any provider that doesn't keep a full build-artifact
 * cache per deployment indefinitely: rebuild, from the known-good commit,
 * right now.
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
 *
 * QUEUED and LAUNCHING are handled specially (see below) rather than
 * falling into the generic transitionDeploymentStatus(..., 'STOPPED') call
 * at the bottom — a build that's still QUEUED or LAUNCHING may not have an
 * build container to stop yet (or may get one any millisecond), so there's nothing
 * safe to call deploymentEngine.stopBuildTask() on yet. See
 * build.worker.ts's cancelRequested handling for the other half of this —
 * it's the one that actually owns finishing a cancel that lands during
 * LAUNCHING.
 */
export async function stopDeployment(
  deploymentId: string,
  userId: string,
  meta: AuditMeta
): Promise<PublicDeployment> {
  // Annotated as the plain Deployment type (not
  // Awaited<ReturnType<typeof assertDeploymentOwnership>>, which includes
  // stateTransitions) because this gets reassigned below to a plain
  // findUniqueOrThrow() result with no include — both shapes are
  // structurally compatible with plain Deployment, just not with each other.
  let deployment: Deployment = await assertDeploymentOwnership(deploymentId, userId);

  if (NON_STOPPABLE_STATUSES.includes(deployment.status)) {
    throw new ConflictError(
      `Cannot stop a deployment that is already ${deployment.status.toLowerCase()}`,
      'DEPLOYMENT_NOT_STOPPABLE'
    );
  }

  if (deployment.status === 'QUEUED') {
    // Atomic claim, racing directly against build.worker.ts's own
    // QUEUED -> LAUNCHING claim on this exact row (same WHERE clause,
    // opposite target status). Postgres serializes concurrent UPDATEs to
    // one row: whichever of the two commits first "wins," and the loser's
    // WHERE re-evaluates against what the winner already committed and
    // matches zero rows. That's what makes this safe without an explicit
    // lock — the row itself is the lock — and it closes the gap the
    // previous version had: read status === 'QUEUED', THEN remove the
    // BullMQ job, THEN write CANCELLED left a window where the worker
    // could already have started launching in between those steps.
    const claimed = await prisma.deployment.updateMany({
      where: { id: deploymentId, status: 'QUEUED' },
      data: { status: 'CANCELLED', stoppedAt: new Date() },
    });

    if (claimed.count === 1) {
      await prisma.deploymentStateTransition.create({
        data: {
          deploymentId,
          fromStatus: 'QUEUED',
          toStatus: 'CANCELLED',
          reason: 'Cancelled by user before the build started',
          triggeredBy: 'user',
        },
      });
      // Cleanup only, at this point — the claim above is what actually
      // guarantees the worker will never launch this job (its own claim
      // against the same row can no longer succeed); removing it from
      // BullMQ just keeps the queue tidy.
      await buildQueue.remove(deploymentId).catch((err) => {
        logger.error('Failed to remove queued build job', { deploymentId, err });
      });

      await audit(userId, 'deployment.cancel', meta, { resourceType: 'deployment', resourceId: deploymentId });
      const cancelled = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
      return toPublicDeployment(cancelled);
    }

    // Lost the claim — build.worker.ts already won QUEUED -> LAUNCHING.
    // Re-read to fall into the LAUNCHING branch below with current data.
    deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
  }

  if (deployment.status === 'LAUNCHING') {
    // No build container id necessarily exists yet (and one may land any
    // millisecond) — the only safe move is to flag intent and let
    // build.worker.ts finish the job the moment it actually has a
    // container to stop (or knows the launch failed outright). See its
    // cancelRequested handling for both outcomes.
    await prisma.deployment.update({ where: { id: deploymentId }, data: { cancelRequested: true } });
    await audit(userId, 'deployment.cancel', meta, { resourceType: 'deployment', resourceId: deploymentId });
    const current = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
    return toPublicDeployment(current);
  }

  if (IN_FLIGHT_BUILD_STATUSES.includes(deployment.status) && deployment.buildContainerId) {
    try {
      await deploymentEngine.stopBuildTask(deployment.buildContainerId);
    } catch (err) {
      // The container may have already exited on its own a moment before
      // this call landed — proceed to mark the row STOPPED regardless;
      // don't leave it stuck mid-flight in the DB just because Docker's
      // view and ours raced.
      logger.error('docker rm on build container failed', { deploymentId, err });
    }
  } else if (deployment.status === 'RUNNING') {
    // Whichever type this is, "stopping" a RUNNING deployment only makes
    // sense if it's the one the project is CURRENTLY serving — both types
    // share one live slot per project (STATIC's one output prefix,
    // DYNAMIC's one app container — see appContainerName's comment), so
    // stopping an old, already-superseded RUNNING row must never touch
    // whatever the project is serving right now.
    const project = await prisma.project.findUnique({
      where: { id: deployment.projectId },
      select: { slug: true, activeDeploymentId: true },
    });

    if (project?.activeDeploymentId === deploymentId) {
      if (deployment.type === 'DYNAMIC') {
        // Falls back to re-deriving the name from the project slug for a
        // row that predates appContainerName being populated (shouldn't
        // happen post-migration, but costs nothing to be defensive about —
        // same instinct as the STATIC branch's `?? __outputs/{slug}/` fallback).
        const containerName = deployment.appContainerName ?? `dreamer-app-${project.slug}`;
        try {
          await deploymentEngine.stopDynamicApp(containerName);
        } catch (err) {
          // Same reasoning as the BUILDING/UPLOADING/STARTING branch above:
          // don't leave the row stuck RUNNING in the DB just because
          // Docker's view and ours raced or the container was already gone.
          logger.error('app container teardown failed', { deploymentId, err });
        }
      } else {
        try {
          await deleteS3Prefix(deployment.outputPrefix ?? `__outputs/${project.slug}/`);
        } catch (err) {
          logger.error('MinIO cleanup failed', { deploymentId, err });
        }
      }
      await prisma.project.update({ where: { id: deployment.projectId }, data: { activeDeploymentId: null } });
      await invalidateRouteCache(project.slug, deployment.projectId);
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
    const project = await prisma.project.update({
      where: { id: updated.projectId },
      data: { activeDeploymentId: deploymentId, lastDeployedAt: now },
      select: { slug: true },
    });
    await invalidateRouteCache(project.slug, updated.projectId);
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
 * The dynamic hand-off point - called from log-relay.ts when
 * build-engine's docker-build.js publishes `image_ready` (see realtime.types.ts).
 * Turns a freshly-built local image into a live, publicly reachable
 * container via deploymentEngine.deployDynamicApp() then transitions the
 * deployment to RUNNING - or FAILED, symmetric with how a launchBuildTask
 * failure is handled in createDeploymentInternal above.
 *
 * Runs AFTER build-engine's own task has already exited (its `docker
 * build` was its last step) - this is why the `docker run` call happens
 * over here, in api-server, rather than in build-engine itself: the build
 * container's job is done the moment the image exists locally.
 */
export async function handleImageReady(
  deploymentId: string,
  event: DeploymentImageReadyEvent
): Promise<Deployment | null> {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!deployment) return null;

  // Persist the built image URI immediately, independent of whether the
  // container deploy that follows succeeds — if deployDynamicApp throws
  // below, a retried/rolled-back deploy (or a human debugging in the
  // dashboard) still sees exactly which image was built, not a blank column.
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { imageUri: event.imageUri, imageSizeBytes: event.imageSizeBytes },
  });

  await transitionDeploymentStatus(deploymentId, 'STARTING', {
    reason: 'Image built — starting container',
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
      imageUri: event.imageUri,
      userEnvVars,
    });

    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        appContainerId: handle.appContainerId,
        appContainerName: handle.appContainerName,
        appUrl: handle.appUrl,
      },
    });

    return await transitionDeploymentStatus(deploymentId, 'RUNNING', {
      url: event.url,
      triggeredBy: 'build-engine',
    });
  } catch (err) {
    return await transitionDeploymentStatus(deploymentId, 'FAILED', {
      reason: 'Failed to start container',
      errorCode: 'CONTAINER_DEPLOY_FAILED',
      errorMessage: err instanceof Error ? err.message : 'Unknown container deploy error',
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
