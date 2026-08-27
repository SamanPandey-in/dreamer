import { z } from 'zod';
import type { Deployment, DeploymentLog, DeploymentStateTransition } from '../generated/prisma/client';

export const createDeploymentSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  body: z.object({
    branch: z.string().min(1).max(255).trim().optional(),
  }),
});

const DEPLOYMENT_STATUS_VALUES = [
  'QUEUED', 'BUILDING', 'UPLOADING', 'STARTING', 'RUNNING',
  'SLEEPING', 'WAKING', 'STOPPED', 'FAILED', 'CANCELLED', 'ERROR',
] as const;

export const listDeploymentsQuerySchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    branch: z.string().trim().min(1).optional(),
    status: z.enum(DEPLOYMENT_STATUS_VALUES).optional(),
    environment: z.enum(['PRODUCTION', 'PREVIEW']).optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
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
export type ListDeploymentsQuery = z.infer<typeof listDeploymentsQuerySchema>['query'];

export interface PublicDeployment {
  id: string;
  projectId: string;
  slug: string;
  status: Deployment['status'];
  type: Deployment['type'];
  framework: Deployment['framework'];
  environment: Deployment['environment'];
  branch: string;
  commitHash: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  deployedById: string | null;
  url: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  errorStep: string | null;
  buildDurationMs: number | null;
  uploadedFileCount: number | null;
  imageSizeBytes: number | null;
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
