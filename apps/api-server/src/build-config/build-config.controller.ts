import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { BadRequestError } from '../lib/errors';
import { decryptFromStorage } from '../lib/crypto';
import { resolveDetectedBuildConfig } from './build-config.service';
import { listPublicPresets } from './framework-presets';
import type { DetectBuildConfigInput } from './build-config.types';

/**
 * Same "decrypt the caller's stored GitHub token" pattern
 * createDeploymentInternal uses in deployment.service.ts for private-repo
 * clones — duplicated rather than imported from there on purpose: that
 * function's token fetch is conditional on `project.isPrivate` (a Project
 * row that doesn't exist yet at wizard time), where this one is
 * unconditional (the wizard always needs to read repo contents to detect
 * anything, public or private).
 */
async function getCallerGithubAccessToken(userId: string): Promise<string> {
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { githubToken: true } });
  if (!owner?.githubToken) {
    throw new BadRequestError(
      'Connect your GitHub account before importing a repository',
      'GITHUB_NOT_CONNECTED'
    );
  }
  return decryptFromStorage(owner.githubToken);
}

/** POST /api/build-config/detect — called by the wizard right after the user confirms a root directory. */
export async function detectBuildConfigHandler(req: Request, res: Response) {
  const { repoFullName, branch, rootDirectory } = req.body as DetectBuildConfigInput;

  const accessToken = await getCallerGithubAccessToken(req.user!.id);
  const detected = await resolveDetectedBuildConfig(accessToken, repoFullName, branch, rootDirectory);

  res.status(200).json({ detected });
}

/**
 * GET /api/build-config/presets — the full preset table, with defaults.
 * Called once when the wizard mounts (not per-keystroke) to populate the
 * "Application Preset" dropdown's options. When the user manually picks a
 * different preset than what was auto-detected, the wizard re-fills the
 * build/install/output fields from THIS list rather than re-calling
 * /detect — switching presets is a local, instant UI action, not something
 * that should wait on a fresh GitHub API round trip.
 */
export async function listPresetsHandler(_req: Request, res: Response) {
  res.status(200).json({ presets: listPublicPresets() });
}
