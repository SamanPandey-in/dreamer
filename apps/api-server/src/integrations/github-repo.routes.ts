import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { listBranchesSchema, listRepoDirectorySchema, searchPublicReposSchema } from './github-repo.types';
import {
  listBranchesHandler,
  listRepoDirectoryHandler,
  listUserReposHandler,
  searchPublicReposHandler,
} from './github-repo.controller';

/** Mounted at /api/github in app.ts. requireAuth applied at the mount point. */
export const githubRepoRouter = Router();

githubRepoRouter.get('/repos', listUserReposHandler);
githubRepoRouter.get('/repo-contents', validate(listRepoDirectorySchema), listRepoDirectoryHandler);
// NEW — "any other publicly available GitHub repo" search bar.
githubRepoRouter.get('/public-repos', validate(searchPublicReposSchema), searchPublicReposHandler);
// NEW — shared by the wizard's branch picker and the project-settings Git panel.
githubRepoRouter.get('/branches', validate(listBranchesSchema), listBranchesHandler);
