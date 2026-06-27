import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { revealEnvVariableRateLimiter } from '../middleware/rate-limiter.middleware';
import {
  createEnvVariableHandler,
  deleteEnvVariableHandler,
  listEnvVariablesHandler,
  revealEnvVariableHandler,
  updateEnvVariableHandler,
} from './env-variables.controller';
import {
  createEnvVariableSchema,
  envVariableIdParamSchema,
  listEnvVariablesQuerySchema,
  updateEnvVariableSchema,
} from './env-variables.types';

/** Mounted by project.routes.ts at /api/projects/:projectId/env-variables. */
export const projectEnvVariablesRouter = Router({ mergeParams: true });
projectEnvVariablesRouter.get('/', validate(listEnvVariablesQuerySchema), listEnvVariablesHandler);
projectEnvVariablesRouter.post('/', validate(createEnvVariableSchema), createEnvVariableHandler);

/** Mounted directly at /api/env-variables — EnvVariable ids are globally unique UUIDs, no projectId needed in the path. */
export const envVariablesRouter = Router();
envVariablesRouter.patch('/:envVariableId', validate(updateEnvVariableSchema), updateEnvVariableHandler);
envVariablesRouter.delete('/:envVariableId', validate(envVariableIdParamSchema), deleteEnvVariableHandler);
envVariablesRouter.post(
  '/:envVariableId/reveal',
  revealEnvVariableRateLimiter,
  validate(envVariableIdParamSchema),
  revealEnvVariableHandler
);