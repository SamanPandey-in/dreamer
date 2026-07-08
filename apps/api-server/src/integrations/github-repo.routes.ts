import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { listRepoDirectorySchema } from './github-repo.types';
import { listRepoDirectoryHandler, listUserReposHandler } from './github-repo.controller';

/** Mounted at /api/github in app.ts. requireAuth applied at the mount point. */
export const githubRepoRouter = Router();

githubRepoRouter.get('/repos', listUserReposHandler);
githubRepoRouter.get('/repo-contents', validate(listRepoDirectorySchema), listRepoDirectoryHandler);
