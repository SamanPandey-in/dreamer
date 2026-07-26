import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { BadRequestError } from '../lib/errors';
import { decryptFromStorage } from '../lib/crypto';
import { listBranches, listRepoDirectory, listUserRepos, searchPublicRepos } from './github-repo.service';
import type { ListBranchesQuery, ListRepoDirectoryQuery, SearchPublicReposQuery } from './github-repo.types';

async function getCallerGithubAccessToken(userId: string): Promise<string> {
    const owner = await prisma.user.findUnique({ where: { id: userId }, select: { githubToken: true } });
    if (!owner?.githubToken) {
        throw new BadRequestError(
            'Connect your GitHub account before importing a repository',
            'GITHUB_ACCOUNT_NOT_CONNECTED'
        );
    }
    return decryptFromStorage(owner.githubToken);
}

/** GET /api/github/repos - the wizard's "Import Git Repository" list (step 1). */
export async function listUserReposHandler(req: Request, res: Response) {
    const accessToken = await getCallerGithubAccessToken(req.user!.id);
    const repos = await listUserRepos(accessToken);
    
    res.status(200).json({ repos });
}

/** GET /api/github/repo-contents - lazily lists one directory level at a time for the root-directory picker.  */
export async function listRepoDirectoryHandler(req: Request, res: Response) {
    const { repoFullName, branch, path } = req.query as unknown as ListRepoDirectoryQuery;

    const accessToken = await getCallerGithubAccessToken(req.user!.id);
    const entries = await listRepoDirectory(accessToken, repoFullName, path, branch);

    res.status(200).json({ entries });
}

/**
 * GET /api/github/public-repos - NEW. Backs the wizard's "any other publicly
 * available GitHub repo" search bar, sitting above the "Your Repositories"
 * list. Uses the caller's own GitHub token purely for API auth/rate-limit
 * purposes — the search itself is scoped server-side (searchPublicRepos
 * forces `is:public`) to only ever return repos the caller may not own or
 * collaborate on at all.
 */
export async function searchPublicReposHandler(req: Request, res: Response) {
    const { query } = req.query as unknown as SearchPublicReposQuery;

    const accessToken = await getCallerGithubAccessToken(req.user!.id);
    const repos = await searchPublicRepos(accessToken, query);

    res.status(200).json({ repos });
}

/**
 * GET /api/github/branches - NEW. Shared by the wizard's branch picker and
 * the project-settings "Production Branch" dropdown — both need "which
 * branches exist on this repo, with the default one flagged" and nothing
 * more.
 */
export async function listBranchesHandler(req: Request, res: Response) {
    const { repoFullName, defaultBranch } = req.query as unknown as ListBranchesQuery;

    const accessToken = await getCallerGithubAccessToken(req.user!.id);
    const branches = await listBranches(accessToken, repoFullName, defaultBranch);

    res.status(200).json({ branches });
}
