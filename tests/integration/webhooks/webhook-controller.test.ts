import '../../setup/test-env';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { buildFakePushPayload } from '../../fixtures/build-fake-webhook-payloads';

const WEBHOOK_SECRET = 'test-webhook-secret-value';

const findProjectsForPush = vi.fn();
const handlePushEvent = vi.fn();

vi.mock('@api/webhooks/github-webhook.service', async () => {
  const actual = await vi.importActual<typeof import('@api/webhooks/github-webhook.service')>(
    '@api/webhooks/github-webhook.service'
  );
  return {
    ...actual,
    findProjectsForPush,
    handlePushEvent,
  };
});
vi.mock('@api/lib/prisma', () => ({ prisma: {} }));
vi.mock('@api/deployments/deployment.service', () => ({
  createWebhookDeployment: vi.fn(),
  hasActiveDeployment: vi.fn(),
}));

const { githubWebhookRouter } = await import('@api/webhooks/github-webhook.routes');
const { errorHandlerMiddleware } = await import('@api/middleware/error-handler.middleware');
const { requestContextMiddleware } = await import('@api/middleware/request-context.middleware');

function buildTestApp() {
  const app = express();
  app.use(requestContextMiddleware);
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use('/api/webhooks/github', githubWebhookRouter);
  app.use(errorHandlerMiddleware);
  return app;
}

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(body)).digest('hex')}`;
}

function postWebhook(app: express.Express, event: string, payload: unknown, opts: { signed?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const signed = opts.signed ?? true;
  const req = request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', event)
    .set('X-GitHub-Delivery', 'test-delivery-id');
  if (signed) req.set('X-Hub-Signature-256', sign(body));
  return req.send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/webhooks/github — signature verification', () => {
  it('returns 401 for a delivery with an invalid signature', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'ping')
      .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64))
      .send(JSON.stringify({ zen: 'Anything not obviously wrong is right.' }));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('WEBHOOK_UNAUTHORIZED');
  });

  it('returns 401 for a delivery with no signature header at all', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'ping')
      .send(JSON.stringify({}));

    expect(res.status).toBe(401);
  });

  it('accepts a correctly-signed delivery', async () => {
    const app = buildTestApp();
    const res = await postWebhook(app, 'ping', { zen: 'Design for failure.' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
  });
});

describe('POST /api/webhooks/github — event routing', () => {
  it('ping: responds 200 { pong: true } without touching the service layer', async () => {
    const app = buildTestApp();
    const res = await postWebhook(app, 'ping', { zen: 'Non-blocking is better than blocking.' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
    expect(handlePushEvent).not.toHaveBeenCalled();
  });

  it('push: valid payload is parsed, matching projects are resolved, and outcomes are returned', async () => {
    findProjectsForPush.mockResolvedValue([{ id: 'project-1', userId: 'user-1' }]);
    handlePushEvent.mockResolvedValue({ deploymentTriggered: true, deploymentId: 'deployment-1' });

    const app = buildTestApp();
    const payload = buildFakePushPayload();
    const res = await postWebhook(app, 'push', payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.outcomes).toEqual([{ deploymentTriggered: true, deploymentId: 'deployment-1' }]);
    expect(findProjectsForPush).toHaveBeenCalledWith(payload.repository.id);
  });

  it('push: malformed payload returns 400', async () => {
    const app = buildTestApp();
    const res = await postWebhook(app, 'push', { ref: 'refs/heads/main' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEBHOOK_BAD_PAYLOAD');
    expect(findProjectsForPush).not.toHaveBeenCalled();
  });

  it('push: no matching project returns 200 ignored', async () => {
    findProjectsForPush.mockResolvedValue([]);
    const app = buildTestApp();
    const res = await postWebhook(app, 'push', buildFakePushPayload());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ received: true, ignored: true, reason: 'No project linked to this repository' })
    );
    expect(handlePushEvent).not.toHaveBeenCalled();
  });

  it('an unrecognized event type is acknowledged 200 (ignored)', async () => {
    const app = buildTestApp();
    const res = await postWebhook(app, 'star', { action: 'created' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ received: true, ignored: true })
    );
    expect(res.body.reason).toContain('star');
  });
});
