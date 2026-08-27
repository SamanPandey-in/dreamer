import type { Project } from '@api/generated/prisma/client';

export function buildFakeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date('2026-01-01T00:00:00.000Z');

  return {
    id: 'project-uuid-1',
    userId: 'user-uuid-1',
    name: 'demo-app',
    slug: 'demo-app-a1b2c3',
    description: null,

    repoUrl: 'https://github.com/SamanPandey-in/demo-app',
    repoFullName: 'SamanPandey-in/demo-app',
    defaultBranch: 'main',
    isPrivate: false,

    installationId: 999111,
    repositoryId: 555222,

    autoDeployEnabled: true,

    buildCommand: null,
    installCommand: null,
    outputDirectory: null,
    rootDirectory: null,

    detectedFramework: 'NEXT_SSR',
    detectedDeploymentType: 'DYNAMIC',

    activeDeploymentId: null,
    lastDeployedAt: null,

    deletedAt: null,
    createdAt: now,
    updatedAt: now,

    ...overrides,
  } as unknown as Project;
}
