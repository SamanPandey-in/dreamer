import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { BadRequestError } from '../lib/errors';
import { decryptFromStorage } from '../lib/crypto';
import { listRepoDirectory, listUserRepos } from './github-repo.service';
import type { ListRepoDirectoryQuery } from './github-repo.types';

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
