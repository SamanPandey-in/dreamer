import { Router } from 'express';
import { githubWebhookHandler } from './github-webhook.controller';

/**
 * Mounted PUBLICLY at /api/webhooks/github in app.ts — deliberately outside
 * every requireAuth-protected router (/api/projects, /api/github, etc.).
 * See github-webhook.controller.ts's doc comment for why signature
 * verification, not a session/JWT, is this route's auth.
 */
export const githubWebhookRouter = Router();

githubWebhookRouter.post('/', githubWebhookHandler);
