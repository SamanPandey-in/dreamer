import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { detectBuildConfigSchema } from './build-config.types';
import { detectBuildConfigHandler, listPresetsHandler } from './build-config.controller';

/** Mounted at /api/build-config in app.ts. requireAuth applied at the mount point, same as projects/deployments. */
export const buildConfigRouter = Router();

buildConfigRouter.get('/presets', listPresetsHandler);
buildConfigRouter.post('/detect', validate(detectBuildConfigSchema), detectBuildConfigHandler);
