import type { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { verifyGithubSignature, findProjectsForPush, handlePushEvent } from './github-webhook.service';
import { githubPushPayloadSchema } from './github-webhook.types';

/**
 * POST /api/webhooks/github — local-engine: a plain classic repo webhook
 * (see docs/architecture/local-engine-auth-and-networking.md Decision 3),
 * added by hand to each repo's own webhook settings, sharing one operator-
 * chosen secret (GITHUB_WEBHOOK_SECRET). Mounted PUBLICLY in app.ts (no
 * requireAuth: GitHub, not a logged-in user, calls this) — signature
 * verification is what stands in for auth here, same role a JWT plays on
 * every other route. Also the only route in this codebase that's ever
 * reachable through the public nginx path when ENABLE_PUSH_DEPLOY=true —
 * see Decision 4.
 *
 * Always returns fast and always returns 2xx once a delivery is verified,
 * even for events this handler chooses not to act on — a webhook endpoint
 * that 4xx/5xxs a well-formed, correctly-signed delivery just because it
 * decided not to do anything with it trains GitHub to mark the hook
 * unhealthy and eventually stop delivering.
 */
export async function githubWebhookHandler(req: Request, res: Response) {
  const rawBody = req.rawBody;
  if (!rawBody) {
    // Only reachable if app.ts's express.json() verify hook was ever
    // removed/bypassed for this route — signature verification is
    // impossible without the exact bytes GitHub signed.
    logger.error('GitHub webhook received with no raw body captured');
    return res.status(500).json({ error: 'Internal server error', code: 'WEBHOOK_RAW_BODY_MISSING' });
  }

  const signature = req.header('X-Hub-Signature-256');
  if (!verifyGithubSignature(rawBody, signature)) {
    // Deliberately vague — same reasoning as any failed-auth response:
    // don't distinguish "no secret configured" from "bad signature" from
    // "tampered body" for an unauthenticated caller.
    logger.warn('GitHub webhook delivery failed signature verification');
    return res.status(401).json({ error: 'Signature verification failed', code: 'WEBHOOK_UNAUTHORIZED' });
  }

  const eventType = req.header('X-GitHub-Event');
  const deliveryId = req.header('X-GitHub-Delivery');

  switch (eventType) {
    case 'ping':
      return res.status(200).json({ pong: true });

    case 'push':
      return handlePush(req, res, deliveryId ?? undefined);

    default:
      // A classic repo webhook only needs to be subscribed to push events
      // (plus GitHub's own automatic ping on setup) — this is defensive,
      // not expected, in case the operator's webhook config sends more.
      return res.status(200).json({ received: true, ignored: true, reason: `Unhandled event type "${eventType}"` });
  }
}

async function handlePush(req: Request, res: Response, deliveryId: string | undefined) {
  const parsed = githubPushPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('GitHub push payload failed validation', { deliveryId });
    return res.status(400).json({ error: 'Malformed push payload', code: 'WEBHOOK_BAD_PAYLOAD' });
  }

  const { repository } = parsed.data;
  const projects = await findProjectsForPush(repository.id);

  if (projects.length === 0) {
    // A valid, correctly-signed delivery for a repo with no matching
    // Project (repositoryId never set, or set to something else) — not an
    // error, nothing to do.
    return res.status(200).json({ received: true, ignored: true, reason: 'No project linked to this repository' });
  }

  // Usually exactly one match; more than one only when the same repo has
  // been imported into multiple projects (see findProjectsForPush) — every
  // matching project gets evaluated independently rather than only the
  // first one found.
  const outcomes = await Promise.all(
    projects.map((project) => handlePushEvent(project, parsed.data, { githubDeliveryId: deliveryId }))
  );

  return res.status(200).json({ received: true, outcomes });
}
