import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { getProjectMetricsHandler } from './metrics.controller';
import { projectMetricsQuerySchema } from './metrics.types';

// mergeParams: true — same convention as projectDeploymentsRouter, needed
// to see :projectId from the parent router this mounts under
// (project.routes.ts).
export const projectMetricsRouter = Router({ mergeParams: true });
projectMetricsRouter.get('/', validate(projectMetricsQuerySchema), getProjectMetricsHandler);
