import { generateSlug } from 'random-word-slugs';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { audit, type AuditMeta } from '../lib/audit';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors';
import { decryptFromStorage } from '../lib/crypto';
import { assertProjectOwnership } from '../projects/project.service'; // concrete file, not the barrel — see §0.5
import { deploymentEngine } from './deployment-engine';
import type {
  CreateDeploymentInput,
  DeploymentDetail,
  PublicDeployment,
  PublicLogLine,
} from './deployment.types';
import type { Deployment, DeploymentLog, DeploymentStatus, Prisma } from '../generated/prisma/client';

const SLUG_MAX_ATTEMPTS = 5;

/** Statuses where a build is still in flight — used by the frontend to decide whether to open a socket at all. */
export const ACTIVE_STATUSES: DeploymentStatus[] = ['QUEUED', 'BUILDING', 'UPLOADING', 'STARTING'];

/** Statuses where no further events will ever arrive for this deployment. */
export const TERMINAL_STATUSES: DeploymentStatus[] = ['RUNNING', 'STOPPED', 'FAILED', 'CANCELLED'];

function toPublicDeployment(deployment: Deployment): PublicDeployment {
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    slug: deployment.slug,
    status: deployment.status,
    type: deployment.type,
    framework: deployment.framework,
    branch: deployment.branch,
    commitHash: deployment.commitHash,
    commitMessage: deployment.commitMessage,
    commitAuthor: deployment.commitAuthor,
    url: deployment.url,
    errorMessage: deployment.errorMessage,
    errorCode: deployment.errorCode,
    errorStep: deployment.errorStep,
    buildDurationMs: deployment.buildDurationMs,
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

/** Deployment.slug is `@unique @db.VarChar(63)` and becomes the live subdomain — same collision-retry reasoning as project.service.ts. */
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

/**
 * Ownership check for a SINGLE deployment, reused by getDeploymentDetail,
 * listDeploymentLogs, AND src/realtime/socket.server.ts (so the socket
 * gateway never re-implements this where-clause itself — see §4.2). Includes
 * stateTransitions because the relation is tiny (a handful of rows per
 * deployment, ever) and every caller except listDeploymentLogs wants it
 * anyway; not worth a second leaner query for that one case.
 */
export async function assertDeploymentOwnership(deploymentId: string, userId: string) {
  const deployment = await prisma.deployment.findFirst({
    where: { id: deploymentId, project: { userId, deletedAt: null } },
    include: { stateTransitions: { orderBy: { createdAt: 'asc' } } },
  });
  if (!deployment) throw new NotFoundError('Deployment not found', 'DEPLOYMENT_NOT_FOUND');
  return deployment;
}

export async function createDeployment(
  projectId: string,
  userId: string,
  input: CreateDeploymentInput,
  meta: AuditMeta
): Promise<PublicDeployment> {
  const project = await assertProjectOwnership(projectId, userId);
  
  // This fails loudly before ever touching ECS — an email/password-only user trying to deploy
  // a private repo gets a clear 400, not a build that queues and then mysteriously hangs.
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

  const branch = input.branch ?? project.defaultBranch;
  const slug = await generateUniqueDeploymentSlug();

  // The Deployment row and its first state-transition row are created
  // atomically — there is never a moment a Deployment exists without a
  // QUEUED transition already recorded, which the timeline UI on the
  // deployment detail page relies on existing from the very first render.
  const deployment = await prisma.$transaction(async (tx) => {
    const created = await tx.deployment.create({
      data: {
        projectId,
        slug,
        branch,
        triggeredBy: 'manual',
        status: 'QUEUED',
        s3Prefix: `__outputs/${slug}/`,
      },
    });

    await tx.deploymentStateTransition.create({
      data: {
        deploymentId: created.id,
        fromStatus: null,
        toStatus: 'QUEUED',
        reason: 'Deployment created',
        triggeredBy: 'api',
      },
    });

    return created;
  });

  await audit(userId, 'deployment.create', meta, { resourceType: 'deployment', resourceId: deployment.id });

  // The ECS call is a real network round trip to AWS — deliberately OUTSIDE
  // the transaction above. Holding a Postgres transaction open across an AWS
  // API call would hold row locks (and a connection from your pool) for as
  // long as ECS takes to respond — exactly the kind of thing that takes a
  // small Postgres instance down under any real concurrency.
  try {
    const handle = await deploymentEngine.launchBuildTask({
      deploymentId: deployment.id,
      deploymentSlug: deployment.slug,
      projectId,
      repoUrl: project.repoUrl,
      branch,
      gitAccessToken,
    });

    const updated = await prisma.deployment.update({
      where: { id: deployment.id },
      data: { ecsTaskArn: handle.ecsTaskArn },
    });

    return toPublicDeployment(updated);
  } catch (err) {
    // The build container never even started — no log lines and no status
    // report will ever come from build-engine for this deployment, so the
    // API itself is responsible for moving it to a terminal state. This is
    // the ONE place outside transitionDeploymentStatus's own callers in
    // realtime/ that calls it directly.
    const failed = await transitionDeploymentStatus(deployment.id, 'FAILED', {
      reason: 'Failed to launch build task',
      errorCode: 'ENGINE_LAUNCH_FAILED',
      errorMessage: err instanceof Error ? err.message : 'Unknown engine error',
      triggeredBy: 'api',
    });
    return toPublicDeployment(failed ?? deployment);
  }
}

export async function listDeploymentsForProject(
  projectId: string,
  userId: string,
  { cursor, limit }: { cursor?: string; limit: number }
): Promise<{ deployments: PublicDeployment[]; nextCursor: string | null }> {
  await assertProjectOwnership(projectId, userId);

  const rows = await prisma.deployment.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit + 1, // fetch one extra row to know whether a next page exists, without a second COUNT query
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
  // DeploymentLog has no userId column of its own — skipping this ownership
  // check would let any authenticated user read any other user's build
  // output by guessing a deployment UUID (a textbook IDOR). The check has to
  // happen here, on every read, not just at deployment-creation time.
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
}

/**
 * THE state machine. Called by the realtime gateway whenever build-engine
 * reports progress (Part 4), and exactly once directly from
 * createDeployment() above, for the one case where build-engine will never
 * get the chance to report anything itself. No other function writes
 * Deployment.status — see the note at the top of this section for why that
 * invariant matters.
 */
export async function transitionDeploymentStatus(
  deploymentId: string,
  toStatus: DeploymentStatus,
  opts: TransitionOptions = {}
): Promise<Deployment | null> {
  const current = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!current) return null; // e.g. the project was hard-deleted mid-build — nothing left to update

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

  // Keep Project's denormalized "what's live right now" fields in sync —
  // the entire reason activeDeploymentId/lastDeployedAt exist on Project
  // (per the schema.prisma comment) is so the dashboard home page can show a
  // status badge with zero extra joins.
  if (toStatus === 'RUNNING') {
    await prisma.project.update({
      where: { id: updated.projectId },
      data: { activeDeploymentId: deploymentId, lastDeployedAt: now },
    });
  }

  return updated;
}

/**
 * Allocates the next sequence number for a deployment's log stream and
 * persists the line. Redis INCR is atomic across concurrent writers — the
 * build container's stdout and stderr are read concurrently (see
 * build-engine/script.js in Part 6) — which `SELECT MAX(sequence) + 1` in
 * Postgres is NOT, without taking an explicit row lock on every write.
 */
export async function appendLogLine(
  deploymentId: string,
  line: { level: DeploymentLog['level']; message: string; source?: string }
): Promise<PublicLogLine> {
  const sequenceKey = `deploy:seq:${deploymentId}`;
  const sequence = await redis.incr(sequenceKey);
  await redis.expire(sequenceKey, 60 * 60 * 24 * 7); // 7 days — comfortably outlives any single build

  const log = await prisma.deploymentLog.create({
    data: { deploymentId, level: line.level, message: line.message, source: line.source, sequence },
  });

  return toPublicLogLine(log);
}
