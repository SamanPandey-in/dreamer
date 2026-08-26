import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { projectDeploymentsRouter } from '../deployments';
import { projectEnvVariablesRouter } from '../env-variables';
import { projectMetricsRouter } from '../metrics';
import { projectCustomDomainsRouter } from '../domains';
import {
  createProjectHandler,
  deleteProjectHandler,
  getProjectHandler,
  listProjectsHandler,
  updateProjectHandler,
} from './project.controller';
import { createProjectSchema, projectIdParamSchema, updateProjectSchema } from './project.types';

export const projectsRouter = Router();

// requireAuth is applied ONCE, where this router is mounted in app.ts —
// every route under /api/projects requires a logged-in user.

projectsRouter.post('/', validate(createProjectSchema), createProjectHandler);
projectsRouter.get('/', listProjectsHandler);
projectsRouter.get('/:projectId', validate(projectIdParamSchema), getProjectHandler);
projectsRouter.patch('/:projectId', validate(updateProjectSchema), updateProjectHandler);
projectsRouter.delete('/:projectId', validate(projectIdParamSchema), deleteProjectHandler);

// Composition, not duplication: sub-routers own their own validation and
// handlers; this router only owns where they mount.
projectsRouter.use('/:projectId/deployments', projectDeploymentsRouter);
projectsRouter.use('/:projectId/env-variables', projectEnvVariablesRouter);
projectsRouter.use('/:projectId/metrics', projectMetricsRouter);
projectsRouter.use('/:projectId/domains', projectCustomDomainsRouter);