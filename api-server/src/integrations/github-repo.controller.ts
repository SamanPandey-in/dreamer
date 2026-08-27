import type { Request, Response } from 'express';
import { getGitAccessToken } from '../lib/git-credentials';
import { listBranches, listOwnRepos, listRepoDirectory, searchPublicRepos } from './github-repo.service';
import type {
  ListBranchesQuery,
  ListRepoDirectoryQuery,
  SearchPublicReposQuery,
} from './github-repo.types';

/**
 * GET /api/github/repos — the wizard's "Import Git Repository" list (step 1):
 * every repo the operator's stored PAT can see (`GET /user/repos`).
 */
export async function listReposHandler(req: Request, res: Response) {
  const accessToken = await getGitAccessToken(req.user!.id);
  if (!accessToken) {
    // Not an error — the wizard falls back to searching public repos by name.
    res.status(200).json({ repos: [] });
    return;
  }

  const repos = await listOwnRepos(accessToken);
  res.status(200).json({ repos });
}

/**
 * GET /api/github/public-repos?query=... — search ANY public GitHub repo by
 * name. Works with NO token set at all — see searchPublicRepos in
 * github-repo.service.ts.
 */
export async function searchPublicReposHandler(req: Request, res: Response) {
  const { query } = req.query as unknown as SearchPublicReposQuery;

  const accessToken = await getGitAccessToken(req.user!.id);
  const repos = await searchPublicRepos(accessToken, query);

  res.status(200).json({ repos });
}

/** GET /api/github/repo-contents - lazily lists one directory level at a time for the root-directory picker. */
export async function listRepoDirectoryHandler(req: Request, res: Response) {
  const { repoFullName, branch, path } = req.query as unknown as ListRepoDirectoryQuery;

  const accessToken = await getGitAccessToken(req.user!.id);
  const entries = await listRepoDirectory(accessToken, repoFullName, path, branch);

  res.status(200).json({ entries });
}

/** GET /api/github/branches - shared by the wizard's branch picker and the project-settings "Production Branch" dropdown. */
export async function listBranchesHandler(req: Request, res: Response) {
  const { repoFullName, defaultBranch } = req.query as unknown as ListBranchesQuery;

  const accessToken = await getGitAccessToken(req.user!.id);
  const branches = await listBranches(accessToken, repoFullName, defaultBranch);

  res.status(200).json({ branches });
}
