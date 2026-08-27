import { randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';
import { audit, type AuditMeta } from '../lib/audit';
import { deleteS3Prefix } from '../lib/s3-client';
import { logger } from '../lib/logger';
import { ConflictError, NotFoundError } from '../lib/errors';
import { getPresetById } from '../build-config/framework-presets';
import type {
  CreateProjectInput,
  LatestDeploymentSummary,
  ProjectWithLatestDeployment,
  PublicProject,
  UpdateProjectInput,
} from './project.types';
import type { Project } from '../generated/prisma/client';

const MAX_SLUG_LENGTH = 63; // Project.slug is @db.VarChar(63) — a DNS label limit
const SLUG_SUFFIX_LENGTH = 6; // "-a1b2c3" — short enough to stay readable, long enough that two retries colliding is effectively impossible
const SLUG_MAX_ATTEMPTS = 5;

// Subdomains/paths a user must not claim as their project's identifier —
// checked like a taken slug, so naming a project "API" yields "api-a1b2c3"
// instead of colliding with platform routing.
const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'dashboard', 'staging', 'static']);

/**
 * Matches https://github.com/owner/repo(.git) and git@github.com:owner/repo.git.
 * Fallback for hand-typed repoUrl — the wizard's repo picker sets
 * repoFullName straight from GitHub's API response instead.
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
    buildCommand: project.buildCommand,
    installCommand: project.installCommand,
    outputDirectory: project.outputDirectory,
    rootDirectory: project.rootDirectory,
    detectedFramework: project.detectedFramework,
    detectedDeploymentType: project.detectedDeploymentType,
    autoDeployEnabled: project.autoDeployEnabled,
    // A push can only trigger a deploy while the project links a repositoryId.
    autoDeployReady: project.repositoryId !== null,
    repositoryId: project.repositoryId,
    createdAt: project.createdAt,
  };
}

/**
 * "My Vite App" -> "my-vite-app": lowercase, non-alphanumeric runs collapsed
 * to a single hyphen, trimmed, capped at the DNS label limit. Falls back to
 * a fixed string when the name has no ASCII alphanumerics at all (e.g.
 * entirely emoji) — the random suffix below still keeps the slug unique.
 */
function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ''); // re-trim in case the length cap landed mid-hyphen

  return slug || 'project';
}

function randomSlugSuffix(): string {
  // randomBytes for consistency with the rest of the codebase — the suffix
  // is a disambiguator, not a secret.
  return randomBytes(Math.ceil(SLUG_SUFFIX_LENGTH / 2))
    .toString('hex')
    .slice(0, SLUG_SUFFIX_LENGTH);
}

async function isSlugAvailable(slug: string): Promise<boolean> {
  if (RESERVED_SLUGS.has(slug)) return false;
  const existing = await prisma.project.findUnique({ where: { slug } });
  return !existing;
}

/**
 * The slug IS the user's project name, slugified — a random suffix appears
 * only as a collision fallback, so the common case gets a clean, readable
 * slug and collisions degrade gracefully instead of erroring.
 */
async function generateUniqueProjectSlug(name: string): Promise<string> {
  const base = slugifyProjectName(name);

  if (await isSlugAvailable(base)) return base;

  // Collision (or reserved word) — fall back to `base-xxxxxx`. Truncate the
  // base first so the suffixed candidate still fits MAX_SLUG_LENGTH.
  const truncatedBase = base.slice(0, MAX_SLUG_LENGTH - (SLUG_SUFFIX_LENGTH + 1));

  for (let attempt = 0; attempt < SLUG_MAX_ATTEMPTS; attempt++) {
    const candidate = `${truncatedBase}-${randomSlugSuffix()}`;
    if (await isSlugAvailable(candidate)) return candidate;
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
  const slug = await generateUniqueProjectSlug(input.name);

  // Only undefined for a non-wizard creation path; UNKNOWN/STATIC is the
  // same safe default the deployment pipeline falls back to.
  const preset = input.frameworkPresetId ? getPresetById(input.frameworkPresetId) : null;

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
      repositoryId: input.repositoryId ?? null,
      // Snapshot of what the user confirmed at creation time — if detection
      // logic improves later, existing projects keep the config they were
      // actually built with until someone edits Settings.
      rootDirectory: input.rootDirectory,
      buildCommand: input.buildCommand,
      installCommand: input.installCommand,
      outputDirectory: input.outputDirectory,
      detectedFramework: preset?.frameworkEnum ?? 'UNKNOWN',
      detectedDeploymentType: preset?.deploymentType ?? 'STATIC',
    },
  });

  await audit(userId, 'project.create', meta, { resourceType: 'project', resourceId: project.id });

  return toPublicProject(project);
}

/**
 * Dashboard home query: one round trip for every project plus just enough
 * of its most recent deployment for a status badge — no N+1 per card.
 * `take: 1` relies on the [projectId, createdAt Desc] index on Deployment.
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
 * Exported for deployment.service.ts. Returns the full row (not
 * PublicProject) because internal callers need repoUrl/defaultBranch —
 * same-process use only, never wire directly to an HTTP route.
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
      buildCommand: input.buildCommand,
      installCommand: input.installCommand,
      outputDirectory: input.outputDirectory,
      rootDirectory: input.rootDirectory,
      autoDeployEnabled: input.autoDeployEnabled,
      repositoryId: input.repositoryId,
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
 * (only listProjectsForUser filters deletedAt: null, so history stays
 * queryable by ID). Also tears down the project's deployed output under its
 * slug prefix: a deleted project shouldn't keep serving traffic, and a new
 * project landing on the same slug later must not inherit stale content.
 * Best-effort and non-blocking — a storage hiccup logs an error but doesn't
 * stop the delete.
 */
export async function softDeleteProject(projectId: string, userId: string, meta: AuditMeta): Promise<void> {
  const project = await findOwnedProject(projectId, userId);

  await prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
  await audit(userId, 'project.delete', meta, { resourceType: 'project', resourceId: projectId });

  try {
    await deleteS3Prefix(`__outputs/${project.slug}/`);
  } catch (err) {
    logger.error('Failed to clean up S3 prefix for project', { projectId, err });
  }
}
