import { randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';
import { audit, type AuditMeta } from '../lib/audit';
import { deleteS3Prefix } from '../lib/s3-client';
import { ConflictError, NotFoundError } from '../lib/errors';
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

// A handful of subdomains/paths that would be confusing or actively
// dangerous for a user to claim as their own project's identifier — checked
// the same way a taken slug is, so a user who names their project "API"
// silently gets "api-a1b2c3" instead of a 500 or, worse, actually claiming it.
const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'dashboard', 'staging', 'static']);

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
    buildCommand: project.buildCommand,
    installCommand: project.installCommand,
    outputDirectory: project.outputDirectory,
    rootDirectory: project.rootDirectory,
    autoDeployEnabled: project.autoDeployEnabled,
    createdAt: project.createdAt,
  };
}

/**
 * "My Vite App" -> "my-vite-app". Lowercase, non-alphanumeric runs collapsed
 * to a single hyphen, leading/trailing hyphens trimmed, hard-capped at the
 * DNS label limit. Falls back to a fixed string for the edge case where the
 * name has no ASCII alphanumeric characters at all (e.g. a name that's
 * entirely emoji or non-Latin script) — the random-suffix fallback below
 * still makes that project's slug unique, it just won't be "named" by this
 * function alone.
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
  // crypto.randomBytes, not Math.random() — not because this needs to be
  // cryptographically unguessable (it's a disambiguation suffix, not a
  // secret), but because Node's CSPRNG is already imported by lib/crypto.ts
  // elsewhere in this codebase and there's no reason to reach for a weaker
  // generator just because the stakes here happen to be lower.
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
 * The project's slug IS its name, slugified — not a random string unrelated
 * to what the user actually called their project. This is what shows up on
 * the dashboard card under the project name (§2.3 of the frontend guide) and
 * it should read as "the project's identifier," not "a dice roll." A random
 * suffix only ever appears as a fallback, and only on the exact name that
 * collided — so the common case (a project name nobody else has used yet)
 * gets a clean slug, and collisions degrade gracefully instead of erroring.
 *
 * This is deliberately scoped to PROJECT slugs only. Deployment.slug (see
 * deployment.service.ts) stays on random-word-slugs unchanged — a
 * deployment isn't named by the user, and Deployment.slug is what actually
 * becomes the live subdomain, where "memorable" matters far less than "the
 * project's slug is what a human looks at on the dashboard."
 */
async function generateUniqueProjectSlug(name: string): Promise<string> {
  const base = slugifyProjectName(name);

  if (await isSlugAvailable(base)) return base;

  // Collision (or a reserved word) — fall back to `base-xxxxxx`. Truncate
  // the base first so the suffixed candidate still fits inside
  // MAX_SLUG_LENGTH even when `base` was already near the limit on its own.
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
      buildCommand: input.buildCommand,
      installCommand: input.installCommand,
      outputDirectory: input.outputDirectory,
      rootDirectory: input.rootDirectory,
      autoDeployEnabled: input.autoDeployEnabled,
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
 *
 * Also tears down the project's live S3 output — a "deleted" project
 * shouldn't keep serving traffic at its subdomain, and (since project.slug
 * is the actual S3 prefix now) leaving it behind would mean a NEW project
 * that happens to land on the same slug later inherits stale content from
 * this one until its first successful deploy overwrites it. Best-effort and
 * non-blocking: an S3 hiccup logs an error but doesn't stop the delete — the
 * user asked to delete a project, not to block on AWS being reachable now.
 */
export async function softDeleteProject(projectId: string, userId: string, meta: AuditMeta): Promise<void> {
  const project = await findOwnedProject(projectId, userId);

  await prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
  await audit(userId, 'project.delete', meta, { resourceType: 'project', resourceId: projectId });

  try {
    await deleteS3Prefix(`__outputs/${project.slug}/`);
  } catch (err) {
    console.error(`[PROJECT_DELETE] Failed to clean up S3 prefix for project ${projectId}:`, err);
  }
}
