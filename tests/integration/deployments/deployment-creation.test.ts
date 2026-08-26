import '../../setup/test-env';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPrismaMock, type PrismaMock } from '../../mocks/prisma.mock';
import { createRedisMock, createBuildQueueMock } from '../../mocks/singletons.mock';
import { buildFakeProject } from '../../fixtures/build-fake-project';
import { detectFramework } from '@api/build-config/framework-detector';
import { loadRepoFixture } from '../../fixtures/load-repo-fixture';

const prismaMock: PrismaMock = createPrismaMock();
const redisMock = createRedisMock();
const buildQueueMock = createBuildQueueMock();
const assertProjectOwnership = vi.fn();

vi.mock('@api/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@api/lib/redis', () => ({ redis: redisMock }));
vi.mock('@api/lib/queue', () => ({ buildQueue: buildQueueMock, BUILD_QUEUE_NAME: 'build-tasks' }));
vi.mock('@api/projects/project.service', () => ({ assertProjectOwnership }));

const { createDeployment } = await import('@api/deployments/deployment.service');

const AUDIT_META = { ipAddress: '203.0.113.10', userAgent: 'vitest' };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.envVariable.findMany.mockResolvedValue([]);
  prismaMock.deployment.findUnique.mockResolvedValue(null);
  prismaMock.$transaction.mockImplementation(async (cb: (tx: PrismaMock) => unknown) => cb(prismaMock));
  buildQueueMock.add.mockResolvedValue({ id: 'mock-job-id' });
});

function fakeCreatedDeploymentFromInput(input: { data: Record<string, unknown> }) {
  return {
    id: 'deployment-uuid-1',
    projectId: input.data.projectId,
    slug: input.data.slug,
    status: 'QUEUED',
    type: input.data.type,
    framework: input.data.framework,
    environment: input.data.environment,
    branch: input.data.branch,
    commitHash: input.data.commitHash ?? null,
    commitMessage: null,
    commitAuthor: null,
    deployedById: input.data.deployedById,
    url: null,
    errorMessage: null,
    errorCode: null,
    errorStep: null,
    buildDurationMs: null,
    uploadedFileCount: null,
    imageSizeBytes: null,
    triggeredBy: input.data.triggeredBy,
    queuedAt: new Date(),
    buildStartedAt: null,
    buildFinishedAt: null,
    deployedAt: null,
    stoppedAt: null,
    createdAt: new Date(),
  };
}

describe('createDeployment — demo dynamic repo (Next.js) end to end', () => {
  it('a project detected as Next.js SSR (DYNAMIC) creates a deployment with type DYNAMIC / framework NEXT_SSR', async () => {
    const { detectionInput, nextConfig } = loadRepoFixture('nextjs-dynamic');
    const detection = detectFramework(detectionInput, nextConfig);
    expect(detection.preset.deploymentType).toBe('DYNAMIC');

    const project = buildFakeProject({
      defaultBranch: 'main',
      isPrivate: false,
      detectedDeploymentType: detection.preset.deploymentType,
      detectedFramework: detection.preset.frameworkEnum,
    });
    assertProjectOwnership.mockResolvedValue(project);
    prismaMock.deployment.create.mockImplementation(async (input: { data: Record<string, unknown> }) =>
      fakeCreatedDeploymentFromInput(input)
    );

    const result = await createDeployment(project.id, project.userId, {}, AUDIT_META);

    expect(result.type).toBe('DYNAMIC');
    expect(result.framework).toBe('NEXT_SSR');
    expect(result.environment).toBe('PRODUCTION');

    expect(buildQueueMock.add).toHaveBeenCalledWith(
      'launch-build',
      expect.objectContaining({ deploymentType: 'DYNAMIC', framework: 'NEXT_SSR' }),
      { jobId: 'deployment-uuid-1' }
    );
  });
});

describe('createDeployment — demo static repo (React) end to end', () => {
  it('a project detected as React + Vite (STATIC) creates a deployment with type STATIC / framework REACT_VITE', async () => {
    const { detectionInput } = loadRepoFixture('react-vite');
    const detection = detectFramework(detectionInput);
    expect(detection.preset.deploymentType).toBe('STATIC');

    const project = buildFakeProject({
      defaultBranch: 'main',
      isPrivate: false,
      detectedDeploymentType: detection.preset.deploymentType,
      detectedFramework: detection.preset.frameworkEnum,
    });
    assertProjectOwnership.mockResolvedValue(project);
    prismaMock.deployment.create.mockImplementation(async (input: { data: Record<string, unknown> }) =>
      fakeCreatedDeploymentFromInput(input)
    );

    const result = await createDeployment(project.id, project.userId, {}, AUDIT_META);

    expect(result.type).toBe('STATIC');
    expect(result.framework).toBe('REACT_VITE');

    expect(buildQueueMock.add).toHaveBeenCalledWith(
      'launch-build',
      expect.objectContaining({ deploymentType: 'STATIC', framework: 'REACT_VITE' }),
      { jobId: 'deployment-uuid-1' }
    );
  });

  it('a React CRA project also resolves to STATIC / REACT_CRA', async () => {
    const { detectionInput } = loadRepoFixture('react-cra');
    const detection = detectFramework(detectionInput);

    const project = buildFakeProject({
      detectedDeploymentType: detection.preset.deploymentType,
      detectedFramework: detection.preset.frameworkEnum,
    });
    assertProjectOwnership.mockResolvedValue(project);
    prismaMock.deployment.create.mockImplementation(async (input: { data: Record<string, unknown> }) =>
      fakeCreatedDeploymentFromInput(input)
    );

    const result = await createDeployment(project.id, project.userId, {}, AUDIT_META);

    expect(result.type).toBe('STATIC');
    expect(result.framework).toBe('REACT_CRA');
  });
});

describe('createDeployment — branch targeting decides PRODUCTION vs PREVIEW environment', () => {
  it('deploying the default branch is a PRODUCTION environment deployment', async () => {
    const project = buildFakeProject({ defaultBranch: 'main' });
    assertProjectOwnership.mockResolvedValue(project);
    prismaMock.deployment.create.mockImplementation(async (input: { data: Record<string, unknown> }) =>
      fakeCreatedDeploymentFromInput(input)
    );

    const result = await createDeployment(project.id, project.userId, { branch: 'main' }, AUDIT_META);
    expect(result.environment).toBe('PRODUCTION');
  });

  it('deploying a non-default branch is a PREVIEW environment deployment', async () => {
    const project = buildFakeProject({ defaultBranch: 'main' });
    assertProjectOwnership.mockResolvedValue(project);
    prismaMock.deployment.create.mockImplementation(async (input: { data: Record<string, unknown> }) =>
      fakeCreatedDeploymentFromInput(input)
    );

    const result = await createDeployment(project.id, project.userId, { branch: 'feature/x' }, AUDIT_META);
    expect(result.environment).toBe('PREVIEW');
  });
});

describe('createDeployment — queue enqueue failure', () => {
  it('marks the deployment FAILED when enqueueing the build job throws', async () => {
    const project = buildFakeProject();
    assertProjectOwnership.mockResolvedValue(project);

    let createdDeployment: Record<string, unknown> | undefined;
    prismaMock.deployment.create.mockImplementation(async (input: { data: Record<string, unknown> }) => {
      createdDeployment = fakeCreatedDeploymentFromInput(input);
      return createdDeployment;
    });
    prismaMock.deployment.findUnique.mockImplementation(async () => createdDeployment ?? null);
    prismaMock.deployment.update.mockImplementation(async (input: { data: Record<string, unknown> }) => ({
      ...createdDeployment,
      ...input.data,
    }));
    buildQueueMock.add.mockRejectedValue(new Error('Redis connection refused'));

    const result = await createDeployment(project.id, project.userId, {}, AUDIT_META);

    expect(result.status).toBe('FAILED');
    expect(prismaMock.deployment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: 'QUEUE_ENQUEUE_FAILED' }),
      })
    );
    expect(prismaMock.deploymentStateTransition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ toStatus: 'FAILED', fromStatus: 'QUEUED' }),
      })
    );
  });
});
