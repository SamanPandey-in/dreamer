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

// A handful of subdomains/paths that would be confusing or actively
// dangerous for a user to claim as their own project's identifier — checked
// the same way a taken slug is, so a user who names their project "API"
// silently gets "api-a1b2c3" instead of a 500 or, worse, actually claiming it.
const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'dashboard', 'staging', 'static']);

/**
 * Matches https://github.com/owner/repo(.git) and git@github.com:owner/repo.git.
 * Still used for display/clone-URL purposes even though repoFullName is no
 * longer what the webhook handler looks projects up by — that's
 * repositoryId now (see webhooks/github-webhook.service.ts's
 * findProjectsForPush). A project created via the wizard's repo picker gets
 * repoFullName straight from GitHub's response instead of this regex; this
 * is the fallback for the rare case repoUrl was typed by hand.
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
    // A push can only ever trigger a deploy once this project actually
    // points at a specific repo's numeric ID — that's the whole check now
    // that there's no per-project installation to also be suspended/removed.
    autoDeployReady: project.repositoryId !== null,
    repositoryId: project.repositoryId,
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
  // secret), but because Node's CSPRNG is already imported elsewhere in
  // this codebase and there's no reason to reach for a weaker generator
  // just because the stakes here happen to be lower.
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
 * the dashboard card under the project name and it should read as "the
 * project's identifier," not "a dice roll." A random suffix only ever
 * appears as a fallback, and only on the exact name that collided — so the
 * common case (a project name nobody else has used yet) gets a clean slug,
 * and collisions degrade gracefully instead of erroring.
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

  // The wizard always sends a frameworkPresetId (even "static" for "we
  // couldn't detect anything") — this only stays undefined for a
  // hypothetical future non-wizard creation path, where UNKNOWN/STATIC is
  // the same safe default createDeploymentInternal already falls back to
  // for every project created before this feature existed.
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
      // See project.types.ts's createProjectSchema doc comment. Recording
      // repositoryId is the entire "connect for auto-deploy" step now — see
      // docs/architecture/local-engine-auth-and-networking.md Decision 3
      // for the manually-configured-webhook flow this feeds.
      repositoryId: input.repositoryId ?? null,
      // NEW — set by the new-project wizard's framework-detection step (see
      // build-config/). Stored as a SNAPSHOT of whatever the user confirmed
      // at creation time, not a live pointer back to the detector — if
      // detection logic improves later, already-created projects keep the
      // config they were actually built with until someone edits Settings.
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
 * user asked to delete a project, not to block on MinIO being reachable now.
 *
 * Nothing GitHub-side to clean up anymore — unlike the per-repo-webhook
 * version of this function (before the GitHub App migration), there's no
 * webhook that belongs to this Project specifically; the App's single
 * webhook keeps existing for every other project regardless.
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
