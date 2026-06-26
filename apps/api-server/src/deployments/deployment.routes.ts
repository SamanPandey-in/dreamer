import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import {
  createDeploymentHandler,
  getDeploymentHandler,
  getDeploymentLogsHandler,
  listDeploymentsHandler,
  rollbackDeploymentHandler,
  stopDeploymentHandler,
} from './deployment.controller';
import {
  createDeploymentSchema,
  deploymentIdParamSchema,
  listDeploymentLogsSchema,
  listDeploymentsQuerySchema,
} from './deployment.types';

export const projectDeploymentsRouter = Router({ mergeParams: true });
projectDeploymentsRouter.post('/', validate(createDeploymentSchema), createDeploymentHandler);
projectDeploymentsRouter.get('/', validate(listDeploymentsQuerySchema), listDeploymentsHandler);

export const deploymentsRouter = Router();
deploymentsRouter.get('/:deploymentId', validate(deploymentIdParamSchema), getDeploymentHandler);
deploymentsRouter.get('/:deploymentId/logs', validate(listDeploymentLogsSchema), getDeploymentLogsHandler);
//  NEW — both reuse deploymentIdParamSchema; neither takes a body.
deploymentsRouter.post('/:deploymentId/rollback', validate(deploymentIdParamSchema), rollbackDeploymentHandler);
deploymentsRouter.post('/:deploymentId/stop', validate(deploymentIdParamSchema), stopDeploymentHandler);