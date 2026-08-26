import { z } from 'zod';
import { FRAMEWORK_PRESETS, type FrameworkPresetId } from '../build-config';
import type { DeploymentType, Framework } from '../generated/prisma/client';

// Validated against the actual preset table (build-config/framework-presets.ts)
// rather than a hand-duplicated z.enum([...]) list — adding a new preset id
// there automatically becomes a valid value here, with no second place to
// remember to update. Cast (not just typed) as the literal tuple so
// z.enum's inferred type is the real FrameworkPresetId union, not a widened
// `string` — this is what lets project.service.ts pass the parsed value
// straight into getPresetById() without an unsafe cast of its own.
const FRAMEWORK_PRESET_IDS = Object.keys(FRAMEWORK_PRESETS) as [FrameworkPresetId, ...FrameworkPresetId[]];

export const createProjectSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255).trim(),
    repoUrl: z.url().max(2048),
    // NEW — the repo's stable GitHub numeric ID, as returned by
    // GET /api/github/repos (see integrations/github-repo.controller.ts).
    // Optional — a project can be created without it (e.g. a repo typed by
    // hand, or a placeholder filled in later); it's the sole webhook lookup
    // key when present (webhooks/github-webhook.service.ts's findProjectsForPush).
    repositoryId: z.number().int().positive().optional(),
    // Defaults to 'main' in the service layer, not here — keeping the
    // "what's the actual default" logic in one place (project.service.ts)
    // rather than splitting it between a zod .default() and a service
    // fallback that could drift out of sync.
    defaultBranch: z.string().min(1).max(255).trim().optional(),
    description: z.string().max(500).trim().optional(),
    isPrivate: z.boolean().optional(),
    // NEW — set by the new-project wizard after framework detection (and any
    // user edits on top of it). All optional: a request that omits them
    // (e.g. an older API client, or a future non-wizard creation path)
    // still creates a project — script.js's own env var fallbacks
    // (INSTALL_COMMAND defaulting to 'npm install', etc.) cover the rest.
    rootDirectory: z.string().max(255).trim().optional(),
    buildCommand: z.string().max(500).trim().optional(),
    installCommand: z.string().max(500).trim().optional(),
    outputDirectory: z.string().max(255).trim().optional(),
    // NEW — which FrameworkPreset the wizard resolved to (either auto-
    // detected, or picked manually from the Application Preset dropdown).
    // Translated to the Prisma Framework/DeploymentType enum pair in
    // project.service.ts via getPresetById — this field carries the preset
    // ID, never the raw Prisma enum value, so the wizard never needs to
    // know the DB's enum naming (NEXT_STATIC vs NEXT_SSR, etc.) at all.
    frameworkPresetId: z.enum(FRAMEWORK_PRESET_IDS).optional(),
  }),
});

export const updateProjectSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  body: z.object({
    name: z.string().min(1).max(255).trim().optional(),
    description: z.string().max(500).trim().optional(),
    defaultBranch: z.string().min(1).max(255).trim().optional(),
    buildCommand: z.string().max(500).trim().optional(),
    installCommand: z.string().max(500).trim().optional(),
    outputDirectory: z.string().max(255).trim().optional(),
    rootDirectory: z.string().max(255).trim().optional(),
    autoDeployEnabled: z.boolean().optional(),
    // Relinking a project to a different repo's numeric ID from Settings.
    repositoryId: z.number().int().positive().optional(),
  }),
});

export const projectIdParamSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>['body'];
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>['body'];

/* Shape returned to the client for a project — never raw DB internals the client has no use for. */
export interface PublicProject {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  repoUrl: string;
  repoFullName: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  activeDeploymentId: string | null;
  lastDeployedAt: Date | null;
  buildCommand: string | null;
  installCommand: string | null;
  outputDirectory: string | null;
  rootDirectory: string | null;
  // NEW — read-only labels of what the wizard detected at creation time.
  // Editing build/install/output commands from Settings never changes these
  // — they describe what was detected, not the current effective config.
  detectedFramework: Framework | null;
  detectedDeploymentType: DeploymentType | null;
  autoDeployEnabled: boolean;
  // Whether a push can actually trigger a deploy right now: the project
  // has a linked repositoryId. See project.service.ts's toPublicProject.
  autoDeployReady: boolean;
  repositoryId: number | null;
  createdAt: Date;
}

/*
 * Deliberately a hand-written, narrow type — NOT an import from
 * deployments/deployment.types.ts. Keeping deployments/ at arm's length from
 * projects/ here (a structural duplicate of a few fields, instead of a
 * cross-feature import) is what keeps the module graph a DAG.
 */
export interface LatestDeploymentSummary {
  id: string;
  slug: string;
  status: string;
  url: string | null;
  branch: string;
  commitMessage: string | null;
  createdAt: Date;
}

export interface ProjectWithLatestDeployment extends PublicProject {
  deploymentCount: number;
  latestDeployment: LatestDeploymentSummary | null;
}