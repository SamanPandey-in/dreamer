import { z } from 'zod';

export const createProjectSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255).trim(),
    repoUrl: z.url().max(2048),
    // Defaults to 'main' in the service layer, not here — keeping the
    // "what's the actual default" logic in one place (project.service.ts)
    // rather than splitting it between a zod .default() and a service
    // fallback that could drift out of sync.
    defaultBranch: z.string().min(1).max(255).trim().optional(),
    description: z.string().max(500).trim().optional(),
    isPrivate: z.boolean().optional(),
  }),
});

export const updateProjectSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  body: z.object({
    name: z.string().min(1).max(255).trim().optional(),
    description: z.string().max(500).trim().optional(),
    defaultBranch: z.string().min(1).max(255).trim().optional(),
  }),
});

export const projectIdParamSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>['body'];
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>['body'];

/* Shape returned to the client for a project — never repoFullName-derivation internals, webhookSecret, etc. */
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