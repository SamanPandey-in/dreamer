import type { Request, Response } from 'express';
import { getGitAccessToken } from '../lib/git-credentials';
import { resolveDetectedBuildConfig } from './build-config.service';
import { listPublicPresets } from './framework-presets';
import type { DetectBuildConfigInput } from './build-config.types';

/** POST /api/build-config/detect — called by the wizard right after the user confirms a root directory. */
export async function detectBuildConfigHandler(req: Request, res: Response) {
  const { repoFullName, branch, rootDirectory } = req.body as DetectBuildConfigInput;

  // Not an error if this comes back undefined — a public repo detects fine
  // unauthenticated (same as browsing its contents/branches did in the
  // wizard's previous step, see integrations/github-repo.service.ts). Only
  // an actually private repo fails downstream from this, with a clear
  // GitHub 404, not a confusing upfront "connect your account."
  const accessToken = await getGitAccessToken(req.user!.id);
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
