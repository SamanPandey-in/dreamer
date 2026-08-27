import '../../setup/test-env';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('@api/lib/prisma', () => ({ prisma: {} }));
vi.mock('@api/deployments/deployment.service', () => ({
  createWebhookDeployment: vi.fn(),
  hasActiveDeployment: vi.fn(),
}));

const WEBHOOK_SECRET = 'test-webhook-secret-value';

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
}

describe('verifyGithubSignature', () => {
  let verifyGithubSignature: typeof import('@api/webhooks/github-webhook.service').verifyGithubSignature;

  beforeEach(async () => {
    ({ verifyGithubSignature } = await import('@api/webhooks/github-webhook.service'));
  });

  it('accepts a correctly-signed body', () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const signature = sign(body);
    expect(verifyGithubSignature(Buffer.from(body), signature)).toBe(true);
  });

  it('rejects a body whose signature was computed with a different secret', () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const signature = sign(body, 'wrong-secret');
    expect(verifyGithubSignature(Buffer.from(body), signature)).toBe(false);
  });

  it('rejects when the body is tampered with after signing', () => {
    const originalBody = JSON.stringify({ ref: 'refs/heads/main', after: 'abc123' });
    const signature = sign(originalBody);
    const tamperedBody = JSON.stringify({ ref: 'refs/heads/main', after: 'evil000' });
    expect(verifyGithubSignature(Buffer.from(tamperedBody), signature)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    expect(verifyGithubSignature(Buffer.from(body), undefined)).toBe(false);
  });

  it('rejects a signature header missing the required "sha256=" prefix', () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const rawHex = createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(body)).digest('hex');
    expect(verifyGithubSignature(Buffer.from(body), rawHex)).toBe(false);
  });

  it('rejects an empty string signature', () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    expect(verifyGithubSignature(Buffer.from(body), '')).toBe(false);
  });

  it('rejects a well-formed but incorrect-length hex signature without throwing', () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    expect(() => verifyGithubSignature(Buffer.from(body), 'sha256=deadbeef')).not.toThrow();
    expect(verifyGithubSignature(Buffer.from(body), 'sha256=deadbeef')).toBe(false);
  });

  it('is sensitive to even a single differing byte in the request body', () => {
    const bodyA = JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40) });
    const bodyB = JSON.stringify({ ref: 'refs/heads/main', after: 'b' + 'a'.repeat(39) });
    const signatureForA = sign(bodyA);
    expect(verifyGithubSignature(Buffer.from(bodyA), signatureForA)).toBe(true);
    expect(verifyGithubSignature(Buffer.from(bodyB), signatureForA)).toBe(false);
  });
});
