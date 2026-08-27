import { z } from 'zod';
import { FRAMEWORK_PRESETS, type FrameworkPresetId } from '../build-config';
import type { DeploymentType, Framework } from '../generated/prisma/client';

// Derived from the preset table (build-config/framework-presets.ts) rather
// than a hand-duplicated list, so new presets become valid here for free.
// The literal-tuple cast keeps z.enum's inferred type the real
// FrameworkPresetId union instead of a widened `string`.
const FRAMEWORK_PRESET_IDS = Object.keys(FRAMEWORK_PRESETS) as [FrameworkPresetId, ...FrameworkPresetId[]];

export const createProjectSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255).trim(),
    repoUrl: z.url().max(2048),
    // Stable GitHub numeric repo ID (GET /api/github/repos). Optional — a
    // project can be created without it; it's the webhook lookup key when
    // present (webhooks/github-webhook.service.ts's findProjectsForPush).
    repositoryId: z.number().int().positive().optional(),
    // Defaults to 'main' in the service layer, not here — keeping the
    // default in one place so a zod .default() and the service can't drift.
    defaultBranch: z.string().min(1).max(255).trim().optional(),
    description: z.string().max(500).trim().optional(),
    isPrivate: z.boolean().optional(),
    // Set by the wizard after framework detection. All optional: requests
    // omitting them still create a project (deploy-time defaults cover the rest).
    rootDirectory: z.string().max(255).trim().optional(),
    buildCommand: z.string().max(500).trim().optional(),
    installCommand: z.string().max(500).trim().optional(),
    outputDirectory: z.string().max(255).trim().optional(),
    // Which FrameworkPreset was resolved (auto-detected or manually picked).
    // Translated to Framework/DeploymentType enums in project.service.ts —
    // clients never deal with DB enum naming.
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
  // Read-only labels of what was detected at creation time — editing build
  // commands from Settings never changes these.
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
 * Deliberately a hand-written, narrow type — not an import from
 * deployments/deployment.types.ts. The structural duplicate keeps the
 * module graph a DAG.
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