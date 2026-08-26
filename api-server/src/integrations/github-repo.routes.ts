import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { listBranchesSchema, listRepoDirectorySchema, searchPublicReposSchema } from './github-repo.types';
import {
  listBranchesHandler,
  listRepoDirectoryHandler,
  listReposHandler,
  searchPublicReposHandler,
} from './github-repo.controller';

/** Mounted at /api/github in app.ts. requireAuth applied at the mount point. */
export const githubRepoRouter = Router();

// local-engine: every repo the operator's stored PAT can see — no
// installationId param anymore, see github-repo.controller.ts.
githubRepoRouter.get('/repos', listReposHandler);
// Any public repo, by name — works with no PAT set at all.
githubRepoRouter.get('/public-repos', validate(searchPublicReposSchema), searchPublicReposHandler);
githubRepoRouter.get('/repo-contents', validate(listRepoDirectorySchema), listRepoDirectoryHandler);
// Shared by the wizard's branch picker and the project-settings Git panel.
githubRepoRouter.get('/branches', validate(listBranchesSchema), listBranchesHandler);
