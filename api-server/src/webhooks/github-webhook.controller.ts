import type { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { verifyGithubSignature, findProjectsForPush, handlePushEvent } from './github-webhook.service';
import { githubPushPayloadSchema } from './github-webhook.types';

/**
 * POST /api/webhooks/github — a plain classic repo webhook
 * (docs/architecture/local-engine-auth-and-networking.md Decision 3), added
 * by hand to each repo's webhook settings, sharing one operator-chosen secret
 * (GITHUB_WEBHOOK_SECRET). Mounted PUBLICLY in app.ts (no requireAuth:
 * GitHub, not a logged-in user, calls this) — signature verification is what
 * stands in for auth here, same role a JWT plays on every other route. When
 * ENABLE_PUSH_DEPLOY=true this is also the only route reachable through the
 * public nginx path (docs Decision 4).
 *
 * Always returns fast and 2xx once a delivery is verified, even for events
 * this handler ignores — 4xx/5xx on well-formed, correctly-signed deliveries
 * trains GitHub to mark the hook unhealthy and eventually stop delivering.
 */
export async function githubWebhookHandler(req: Request, res: Response) {
  const rawBody = req.rawBody;
  if (!rawBody) {
    // Only reachable if app.ts's express.json() verify hook was removed —
    // signature verification needs the exact bytes GitHub signed.
    logger.error('GitHub webhook received with no raw body captured');
    return res.status(500).json({ error: 'Internal server error', code: 'WEBHOOK_RAW_BODY_MISSING' });
  }

  const signature = req.header('X-Hub-Signature-256');
  if (!verifyGithubSignature(rawBody, signature)) {
    // Deliberately vague — don't distinguish "no secret configured" from
    // "bad signature" from "tampered body" for an unauthenticated caller.
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
      // A classic repo webhook only needs push events (plus GitHub's own ping
      // on setup) — this is defensive, in case the operator's webhook config
      // subscribes to more.
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
    // Valid, correctly-signed delivery for a repo with no matching Project —
    // not an error, nothing to do.
    return res.status(200).json({ received: true, ignored: true, reason: 'No project linked to this repository' });
  }

  // Usually exactly one match; more than one only when the same repo was
  // imported into multiple projects (see findProjectsForPush) — every match
  // is evaluated independently rather than only the first one found.
  const outcomes = await Promise.all(
    projects.map((project) => handlePushEvent(project, parsed.data, { githubDeliveryId: deliveryId }))
  );

  return res.status(200).json({ received: true, outcomes });
}
