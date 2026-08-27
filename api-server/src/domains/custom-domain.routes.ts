import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import {
  createCustomDomainHandler,
  deleteCustomDomainHandler,
  listCustomDomainsHandler,
  verifyCustomDomainHandler,
} from './custom-domain.controller';
import {
  createCustomDomainSchema,
  customDomainIdParamSchema,
  listCustomDomainsSchema,
} from './custom-domain.types';

/** Mounted by project.routes.ts at /api/projects/:projectId/domains. */
export const projectCustomDomainsRouter = Router({ mergeParams: true });
projectCustomDomainsRouter.get('/', validate(listCustomDomainsSchema), listCustomDomainsHandler);
projectCustomDomainsRouter.post('/', validate(createCustomDomainSchema), createCustomDomainHandler);

/** Mounted directly at /api/domains — CustomDomain ids are globally unique UUIDs, no projectId needed in the path. */
export const customDomainsRouter = Router();
customDomainsRouter.post('/:domainId/verify', validate(customDomainIdParamSchema), verifyCustomDomainHandler);
customDomainsRouter.delete('/:domainId', validate(customDomainIdParamSchema), deleteCustomDomainHandler);
