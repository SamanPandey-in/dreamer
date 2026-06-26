import { z } from 'zod';
import type { Deployment, DeploymentLog, DeploymentStateTransition } from '../generated/prisma/client';

export const createDeploymentSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  body: z.object({
    branch: z.string().min(1).max(255).trim().optional(),
  }),
});

export const listDeploymentsQuerySchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
});

export const deploymentIdParamSchema = z.object({
  params: z.object({ deploymentId: z.uuid() }),
});

export const listDeploymentLogsSchema = z.object({
  params: z.object({ deploymentId: z.uuid() }),
  query: z.object({
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  }),
});

export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>['body'];

export interface PublicDeployment {
  id: string;
  projectId: string;
  slug: string;
  status: Deployment['status'];
  type: Deployment['type'];
  framework: Deployment['framework'];
  branch: string;
  commitHash: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  url: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  errorStep: string | null;
  buildDurationMs: number | null;
  uploadedFileCount: number | null; //  NEW
  imageSizeBytes: number | null; //  NEW
  triggeredBy: string;
  queuedAt: Date;
  buildStartedAt: Date | null;
  buildFinishedAt: Date | null;
  deployedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
}

export interface PublicStateTransition {
  id: string;
  fromStatus: DeploymentStateTransition['fromStatus'];
  toStatus: DeploymentStateTransition['toStatus'];
  reason: string | null;
  createdAt: Date;
}

export interface PublicLogLine {
  id: string;
  level: DeploymentLog['level'];
  message: string;
  sequence: number;
  source: string | null;
  timestamp: Date;
}

export interface DeploymentDetail extends PublicDeployment {
  stateTransitions: PublicStateTransition[];
}
