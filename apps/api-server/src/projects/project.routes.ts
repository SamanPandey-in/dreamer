import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { projectDeploymentsRouter } from '../deployments';
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
// every route under /api/projects requires a logged-in user. Unlike
// /api/auth (where /register, /login, /github are intentionally public),
// nothing here ever is, so there's no per-route case to handle.

projectsRouter.post('/', validate(createProjectSchema), createProjectHandler);
projectsRouter.get('/', listProjectsHandler);
projectsRouter.get('/:projectId', validate(projectIdParamSchema), getProjectHandler);
projectsRouter.patch('/:projectId', validate(updateProjectSchema), updateProjectHandler);
projectsRouter.delete('/:projectId', validate(projectIdParamSchema), deleteProjectHandler);

// Composition, not duplication: deployments/ owns its own validation and
// handlers for everything under .../deployments; this router only owns
// where that sub-router gets mounted.
projectsRouter.use('/:projectId/deployments', projectDeploymentsRouter);
