import { generateSlug } from 'random-word-slugs';
import { prisma } from '../lib/prisma';
import { audit, type AuditMeta } from '../lib/audit';
import { ConflictError, NotFoundError } from '../lib/errors';
import type {
  CreateProjectInput,
  LatestDeploymentSummary,
  ProjectWithLatestDeployment,
  PublicProject,
  UpdateProjectInput,
} from './project.types';
import type { Project } from '../generated/prisma/client';

const SLUG_MAX_ATTEMPTS = 5;

/**
 * Matches https://github.com/owner/repo(.git) and git@github.com:owner/repo.git.
 * repoFullName exists on the schema specifically so the (future) GitHub
 * webhook handler can do `WHERE repoFullName = payload.repository.full_name`
 * instead of string-matching repoUrl — see the index comment in schema.prisma.
 * Parsing it once, at creation time, means that lookup is ready the moment
 * webhooks get built, with zero migration.
 */
function parseRepoFullName(repoUrl: string): string | null {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function toPublicProject(project: Project): PublicProject {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    repoUrl: project.repoUrl,
    repoFullName: project.repoFullName,
    defaultBranch: project.defaultBranch,
    isPrivate: project.isPrivate,
    activeDeploymentId: project.activeDeploymentId,
    lastDeployedAt: project.lastDeployedAt,
    createdAt: project.createdAt,
  };
}

/**
 * Project.slug is `@unique @db.VarChar(63)` (a DNS label). Collisions from
 * random-word-slugs are rare but not impossible — retrying a handful of
 * times here means a collision is invisible to the user, instead of
 * surfacing as a raw Prisma P2002 error from a 500.
 */
async function generateUniqueProjectSlug(): Promise<string> {
  for (let attempt = 0; attempt < SLUG_MAX_ATTEMPTS; attempt++) {
    const candidate = generateSlug();
    const existing = await prisma.project.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
  }
  throw new ConflictError(
    'Could not generate a unique project slug — please try again',
    'SLUG_GENERATION_FAILED'
  );
}

export async function createProject(
  userId: string,
  input: CreateProjectInput,
  meta: AuditMeta
): Promise<PublicProject> {
  const slug = await generateUniqueProjectSlug();

  const project = await prisma.project.create({
    data: {
      userId,
      name: input.name,
      slug,
      description: input.description,
      repoUrl: input.repoUrl,
      repoFullName: parseRepoFullName(input.repoUrl),
      defaultBranch: input.defaultBranch ?? 'main',
      isPrivate: input.isPrivate ?? false,
    },
  });

  await audit(userId, 'project.create', meta, { resourceType: 'project', resourceId: project.id });

  return toPublicProject(project);
}

/**
 * The dashboard home page query. One round trip for every project the user
 * owns, plus just enough of its most recent deployment to render a status
 * badge — no N+1 query per card. `take: 1` per project relies on the
 * `[projectId, createdAt(sort: Desc)]` index already defined on Deployment
 * in schema.prisma for exactly this access pattern.
 */
export async function listProjectsForUser(userId: string): Promise<ProjectWithLatestDeployment[]> {
  const projects = await prisma.project.findMany({
    where: { userId, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    include: {
      deployments: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          slug: true,
          status: true,
          url: true,
          branch: true,
          commitMessage: true,
          createdAt: true,
        },
      },
      _count: { select: { deployments: true } },
    },
  });

  return projects.map((project) => {
    const latest = project.deployments[0];
    const latestDeployment: LatestDeploymentSummary | null = latest
      ? {
          id: latest.id,
          slug: latest.slug,
          status: latest.status,
          url: latest.url,
          branch: latest.branch,
          commitMessage: latest.commitMessage,
          createdAt: latest.createdAt,
        }
      : null;

    return {
      ...toPublicProject(project),
      deploymentCount: project._count.deployments,
      latestDeployment,
    };
  });
}

async function findOwnedProject(projectId: string, userId: string): Promise<Project> {
  const project = await prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null } });
  if (!project) throw new NotFoundError('Project not found', 'PROJECT_NOT_FOUND');
  return project;
}

export async function getProjectById(projectId: string, userId: string): Promise<PublicProject> {
  return toPublicProject(await findOwnedProject(projectId, userId));
}

/**
 * Exported specifically for deployment.service.ts to call — see §0.5 for why
 * that import goes through this concrete file and never through
 * projects/index.ts. Returns the full row (not PublicProject) because
 * deployment.service.ts needs repoUrl and defaultBranch, which aren't on the
 * public DTO's typical client-facing shape but absolutely are here since
 * this function is for internal, same-process use only — never wire this up
 * to an HTTP route directly.
 */
export async function assertProjectOwnership(projectId: string, userId: string): Promise<Project> {
  return findOwnedProject(projectId, userId);
}

export async function updateProject(
  projectId: string,
  userId: string,
  input: UpdateProjectInput,
  meta: AuditMeta
): Promise<PublicProject> {
  await findOwnedProject(projectId, userId); // 404s before issuing the UPDATE

  const project = await prisma.project.update({
    where: { id: projectId },
    data: {
      name: input.name,
      description: input.description,
      defaultBranch: input.defaultBranch,
    },
  });

  await audit(userId, 'project.update', meta, {
    resourceType: 'project',
    resourceId: projectId,
    metadata: input,
  });

  return toPublicProject(project);
}

/**
 * Soft delete — keeps every Deployment/DeploymentLog/AuditLog row intact
 * (the FK is onDelete: Cascade only for a HARD delete; this never issues
 * one). Only listProjectsForUser filters deletedAt: null, so the history
 * stays queryable directly by ID if you ever need to investigate "what was
 * this project before it was deleted."
 */
export async function softDeleteProject(projectId: string, userId: string, meta: AuditMeta): Promise<void> {
  await findOwnedProject(projectId, userId);

  await prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
  await audit(userId, 'project.delete', meta, { resourceType: 'project', resourceId: projectId });
}
