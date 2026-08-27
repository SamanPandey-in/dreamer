import '../../setup/test-env';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPrismaMock, type PrismaMock } from '../../mocks/prisma.mock';
import { buildFakeProject } from '../../fixtures/build-fake-project';
import { buildFakePushPayload } from '../../fixtures/build-fake-webhook-payloads';

const prismaMock: PrismaMock = createPrismaMock();
const createWebhookDeployment = vi.fn();
const hasActiveDeployment = vi.fn();

vi.mock('@api/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@api/deployments/deployment.service', () => ({
  createWebhookDeployment,
  hasActiveDeployment,
}));

const {
  findProjectsForPush,
  handlePushEvent,
} = await import('@api/webhooks/github-webhook.service');

beforeEach(() => {
  vi.clearAllMocks();
  hasActiveDeployment.mockResolvedValue(false);
  createWebhookDeployment.mockResolvedValue({ id: 'deployment-uuid-1' });
  prismaMock.webhookDelivery.create.mockResolvedValue({});
});

describe('findProjectsForPush', () => {
  it('looks projects up by repositoryId, scoped to non-deleted projects', async () => {
    prismaMock.project.findMany.mockResolvedValue([buildFakeProject()]);

    const result = await findProjectsForPush(555222);

    expect(prismaMock.project.findMany).toHaveBeenCalledWith({
      where: { repositoryId: 555222, deletedAt: null },
    });
    expect(result).toHaveLength(1);
  });
});

describe('handlePushEvent — webhook / auto-deploy feature ON', () => {
  it('triggers a deployment when auto-deploy is enabled and the push is to the production branch', async () => {
    const project = buildFakeProject({ autoDeployEnabled: true, defaultBranch: 'main' });
    const payload = buildFakePushPayload({ ref: 'refs/heads/main' });

    const outcome = await handlePushEvent(project, payload, { githubDeliveryId: 'delivery-1' });

    expect(outcome.deploymentTriggered).toBe(true);
    expect(outcome.deploymentId).toBe('deployment-uuid-1');
    expect(outcome.skipReason).toBeUndefined();

    expect(createWebhookDeployment).toHaveBeenCalledWith(
      project.id,
      project.userId,
      { branch: 'main', commitHash: payload.after },
      { userAgent: 'GitHub-Webhook' }
    );
  });

  it('records the delivery with deploymentTriggered: true and the resulting deploymentId', async () => {
    const project = buildFakeProject({ autoDeployEnabled: true, defaultBranch: 'main' });
    const payload = buildFakePushPayload({ ref: 'refs/heads/main' });

    await handlePushEvent(project, payload, { githubDeliveryId: 'delivery-42' });

    expect(prismaMock.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: project.id,
        githubDeliveryId: 'delivery-42',
        event: 'PUSH',
        branch: 'main',
        commitHash: payload.after,
        commitMessage: payload.head_commit?.message,
        deploymentTriggered: true,
        deploymentId: 'deployment-uuid-1',
        skipReason: undefined,
        rawPayload: payload,
      }),
    });
  });

  it('strips the refs/heads/ prefix before comparing/recording the branch', async () => {
    const project = buildFakeProject({ defaultBranch: 'develop' });
    const payload = buildFakePushPayload({ ref: 'refs/heads/develop' });

    const outcome = await handlePushEvent(project, payload, {});

    expect(outcome.deploymentTriggered).toBe(true);
    expect(prismaMock.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ branch: 'develop' }) })
    );
  });
});

describe('handlePushEvent — webhook / auto-deploy feature OFF', () => {
  it('does NOT trigger a deployment when autoDeployEnabled is false, even on the production branch', async () => {
    const project = buildFakeProject({ autoDeployEnabled: false, defaultBranch: 'main' });
    const payload = buildFakePushPayload({ ref: 'refs/heads/main' });

    const outcome = await handlePushEvent(project, payload, { githubDeliveryId: 'delivery-2' });

    expect(outcome.deploymentTriggered).toBe(false);
    expect(outcome.skipReason).toBe('Auto-deploy is disabled for this project');
    expect(outcome.deploymentId).toBeUndefined();
    expect(createWebhookDeployment).not.toHaveBeenCalled();
  });

  it('still records the delivery with deploymentTriggered: false', async () => {
    const project = buildFakeProject({ autoDeployEnabled: false });
    const payload = buildFakePushPayload();

    await handlePushEvent(project, payload, { githubDeliveryId: 'delivery-3' });

    expect(prismaMock.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deploymentTriggered: false,
        deploymentId: undefined,
        skipReason: 'Auto-deploy is disabled for this project',
      }),
    });
  });

  it('checking autoDeployEnabled happens before the branch check', async () => {
    const project = buildFakeProject({ autoDeployEnabled: false, defaultBranch: 'main' });
    const payload = buildFakePushPayload({ ref: 'refs/heads/some-feature-branch' });

    const outcome = await handlePushEvent(project, payload, {});

    expect(outcome.skipReason).toBe('Auto-deploy is disabled for this project');
  });
});

describe('handlePushEvent — branch filtering', () => {
  it('skips a push to a non-production branch and reports which branch was expected', async () => {
    const project = buildFakeProject({ autoDeployEnabled: true, defaultBranch: 'main' });
    const payload = buildFakePushPayload({ ref: 'refs/heads/feature/new-thing' });

    const outcome = await handlePushEvent(project, payload, {});

    expect(outcome.deploymentTriggered).toBe(false);
    expect(outcome.skipReason).toBe('Branch "feature/new-thing" is not the production branch ("main")');
    expect(createWebhookDeployment).not.toHaveBeenCalled();
  });
});

describe('handlePushEvent — branch deletion', () => {
  it('skips when the push represents a branch deletion', async () => {
    const project = buildFakeProject({ autoDeployEnabled: true, defaultBranch: 'main' });
    const payload = buildFakePushPayload({ ref: 'refs/heads/main', deleted: true, head_commit: null });

    const outcome = await handlePushEvent(project, payload, {});

    expect(outcome.deploymentTriggered).toBe(false);
    expect(outcome.skipReason).toBe('Push was a branch deletion');
    expect(createWebhookDeployment).not.toHaveBeenCalled();
  });
});

describe('handlePushEvent — concurrency guard', () => {
  it('skips when a deployment for this project is already active', async () => {
    hasActiveDeployment.mockResolvedValue(true);
    const project = buildFakeProject({ autoDeployEnabled: true, defaultBranch: 'main' });
    const payload = buildFakePushPayload({ ref: 'refs/heads/main' });

    const outcome = await handlePushEvent(project, payload, {});

    expect(outcome.deploymentTriggered).toBe(false);
    expect(outcome.skipReason).toBe('A deployment for this project is already in progress');
    expect(createWebhookDeployment).not.toHaveBeenCalled();
  });
});

describe('handlePushEvent — enqueue failure', () => {
  it('never throws when createWebhookDeployment rejects — records the failure on the delivery instead', async () => {
    createWebhookDeployment.mockRejectedValue(new Error('Redis unavailable'));
    const project = buildFakeProject({ autoDeployEnabled: true, defaultBranch: 'main' });
    const payload = buildFakePushPayload({ ref: 'refs/heads/main' });

    const outcome = await handlePushEvent(project, payload, {});

    expect(outcome.deploymentTriggered).toBe(false);
    expect(outcome.skipReason).toBe('Failed to start deployment: Redis unavailable');
    expect(prismaMock.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deploymentTriggered: false }) })
    );
  });
});

describe('handlePushEvent — multiple matching projects', () => {
  it('evaluates every project independently when the same repo is imported into more than one project', async () => {
    const projectA = buildFakeProject({ id: 'project-a', autoDeployEnabled: true, defaultBranch: 'main' });
    const projectB = buildFakeProject({ id: 'project-b', autoDeployEnabled: false, defaultBranch: 'main' });
    const payload = buildFakePushPayload({ ref: 'refs/heads/main' });

    const outcomeA = await handlePushEvent(projectA, payload, {});
    const outcomeB = await handlePushEvent(projectB, payload, {});

    expect(outcomeA.deploymentTriggered).toBe(true);
    expect(outcomeB.deploymentTriggered).toBe(false);
    expect(createWebhookDeployment).toHaveBeenCalledTimes(1);
  });
});
