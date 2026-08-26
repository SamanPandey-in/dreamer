import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { env } from '../lib/env';
import { createWebhookDeployment, hasActiveDeployment } from '../deployments/deployment.service';
import type { GithubPushPayload } from './github-webhook.types';
import type { Project } from '../generated/prisma/client';

const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * GitHub signs every delivery's exact request body as
 * `X-Hub-Signature-256: sha256=<hex hmac>`, using whatever secret the
 * operator pasted into the repo's own webhook settings AND into this box's
 * GITHUB_WEBHOOK_SECRET env var (see
 * docs/architecture/local-engine-auth-and-networking.md Decision 3 — a
 * plain classic repo webhook now, not an App-wide one). If no secret is
 * configured at all, every delivery fails verification — there is
 * deliberately no "skip verification" fallback: an unset secret should
 * mean push-deploy simply doesn't work yet, not that it works unverified.
 *
 * timingSafeEqual over the raw digest bytes, not the two hex strings —
 * comparing hex strings char-by-char with a naive === reopens the same
 * timing side-channel this exists to prevent.
 */
export function verifyGithubSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  if (!env.GITHUB_WEBHOOK_SECRET) return false;

  const expected = createHmac('sha256', env.GITHUB_WEBHOOK_SECRET).update(rawBody).digest();
  const provided = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');

  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * `repository.id` is the intended lookup key, but nothing in the schema
 * enforces it as unique on Project — two different projects can both point
 * at the same repo. Returning every match (rather than findFirst, which
 * would pick whichever row Postgres happens to return first and silently
 * leave the other never auto-deploying) means a shared repo just deploys
 * every project that imported it, which is the same "every match reacts"
 * behavior GitHub's own delivery already assumes for webhooks with
 * multiple subscribers.
 */
export async function findProjectsForPush(repositoryId: number): Promise<Project[]> {
  return prisma.project.findMany({ where: { repositoryId, deletedAt: null } });
}

export interface WebhookDeliveryOutcome {
  deploymentTriggered: boolean;
  deploymentId?: string;
  skipReason?: string;
}

/**
 * The actual "should this push redeploy?" decision + side effects, once
 * signature verification has already passed and a matching project has
 * been found. Scope is deliberately narrow per this feature's brief:
 * production-branch pushes only — no preview deployments, no PR handling.
 */
export async function handlePushEvent(
  project: Project,
  payload: GithubPushPayload,
  meta: { githubDeliveryId?: string }
): Promise<WebhookDeliveryOutcome> {
  const branch = payload.ref.startsWith(BRANCH_REF_PREFIX) ? payload.ref.slice(BRANCH_REF_PREFIX.length) : payload.ref;

  const outcome = await decideOutcome(project, payload, branch);

  await prisma.webhookDelivery.create({
    data: {
      projectId: project.id,
      githubDeliveryId: meta.githubDeliveryId,
      event: 'PUSH',
      branch,
      commitHash: payload.after,
      commitMessage: payload.head_commit?.message,
      deploymentTriggered: outcome.deploymentTriggered,
      deploymentId: outcome.deploymentId,
      skipReason: outcome.skipReason,
      rawPayload: payload,
    },
  });

  return outcome;
}

async function decideOutcome(project: Project, payload: GithubPushPayload, branch: string): Promise<WebhookDeliveryOutcome> {
  if (payload.deleted) {
    return { deploymentTriggered: false, skipReason: 'Push was a branch deletion' };
  }

  if (!project.autoDeployEnabled) {
    return { deploymentTriggered: false, skipReason: 'Auto-deploy is disabled for this project' };
  }

  if (branch !== project.defaultBranch) {
    // Deliberately not a "preview deployment" path — out of scope for this
    // feature. A push to any branch other than the configured production
    // branch is logged (so "why didn't my push deploy" is answerable from
    // the WebhookDelivery table) and otherwise ignored.
    return {
      deploymentTriggered: false,
      skipReason: `Branch "${branch}" is not the production branch ("${project.defaultBranch}")`,
    };
  }

  if (await hasActiveDeployment(project.id)) {
    return { deploymentTriggered: false, skipReason: 'A deployment for this project is already in progress' };
  }

  try {
    const deployment = await createWebhookDeployment(
      project.id,
      project.userId,
      { branch, commitHash: payload.after },
      { userAgent: 'GitHub-Webhook' }
    );
    return { deploymentTriggered: true, deploymentId: deployment.id };
  } catch (err) {
    // Never let a failure to ENQUEUE the build make this handler throw —
    // GitHub interprets a non-2xx as "redeliver this," and retried
    // redeliveries of the same push wouldn't fix an underlying problem
    // like a revoked installation. Log it, record it on the delivery row,
    // and let the user retry manually (redeploy button) instead.
    logger.error('Webhook-triggered deployment failed to enqueue', { projectId: project.id, err });
    return {
      deploymentTriggered: false,
      skipReason: `Failed to start deployment: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}
