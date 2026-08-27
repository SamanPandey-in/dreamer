import type { Request, Response } from 'express';
import { getGitAccessToken } from '../lib/git-credentials';
import { resolveDetectedBuildConfig } from './build-config.service';
import { listPublicPresets } from './framework-presets';
import type { DetectBuildConfigInput } from './build-config.types';

/** POST /api/build-config/detect — called by the wizard right after the user confirms a root directory. */
export async function detectBuildConfigHandler(req: Request, res: Response) {
  const { repoFullName, branch, rootDirectory } = req.body as DetectBuildConfigInput;

  // Not an error if undefined — a public repo detects fine unauthenticated;
  // only a genuinely private repo fails downstream with a clear GitHub 404,
  // not an upfront "connect your account."
  const accessToken = await getGitAccessToken(req.user!.id);
  const detected = await resolveDetectedBuildConfig(accessToken, repoFullName, branch, rootDirectory);

  res.status(200).json({ detected });
}

/**
 * GET /api/build-config/presets — the full preset table with defaults,
 * fetched once when the wizard mounts. When the user manually picks a
 * different preset than what was auto-detected, the build/install/output
 * fields refill from THIS list rather than re-calling /detect — switching
 * presets is a local UI action, not a fresh GitHub round trip.
 */
export async function listPresetsHandler(_req: Request, res: Response) {
  res.status(200).json({ presets: listPublicPresets() });
}
