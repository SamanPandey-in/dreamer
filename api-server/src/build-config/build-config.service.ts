import { fetchPackageJson, fetchRepoFile, listRepoDirectory } from '../integrations/github-repo.service';
import { detectFramework, needsNextConfigSource, type PackageJsonShape } from './framework-detector';
import { detectPackageManager } from './package-manager-detector';
import type { DetectedBuildConfig } from './build-config.types';

/**
 * Resolves the wizard's "Continue" click on the root-directory step into a
 * full detected build config — up to three GitHub calls: the root listing,
 * package.json (if present), and next.config.*'s source (only when a Next.js
 * config file was actually found).
 *
 * Deliberately returns a DetectedBuildConfig, never writes anything to the
 * database — detection output is always staged as editable form state first,
 * and only becomes a stored Project row when the user submits the wizard.
 */
export async function resolveDetectedBuildConfig(
  accessToken: string | undefined,
  repoFullName: string,
  branch: string,
  rootDirectory: string
): Promise<DetectedBuildConfig> {
  const rootEntries = await listRepoDirectory(accessToken, repoFullName, rootDirectory, branch);
  const rootFiles = rootEntries.filter((entry) => entry.type === 'file').map((entry) => entry.name);

  const packageJson = rootFiles.includes('package.json')
    ? ((await fetchPackageJson(accessToken, repoFullName, rootDirectory, branch)) as PackageJsonShape | null)
    : null;

  const nextConfigFilename = needsNextConfigSource(rootFiles);
  const nextConfigSource = nextConfigFilename
    ? await fetchRepoFile(
        accessToken,
        repoFullName,
        rootDirectory ? `${rootDirectory}/${nextConfigFilename}` : nextConfigFilename,
        branch
      )
    : null;

  const { preset, matchedOn } = detectFramework(
    { rootFiles, packageJson },
    nextConfigFilename ? { filename: nextConfigFilename, source: nextConfigSource } : undefined
  );

  const packageManager = detectPackageManager(rootFiles);

  // Package-manager detection overrides the preset's generic `npm install`
  // default — framework tells us WHAT to build, lockfile presence tells us
  // HOW to install. Build command/output stay framework-specific.
  return {
    framework: {
      id: preset.id,
      label: preset.label,
      deploymentType: preset.deploymentType,
      requiresUnsupportedRuntime: preset.requiresUnsupportedRuntime,
    },
    matchedOn,
    installCommand: packageManager.installCommand,
    buildCommand: preset.defaultBuildCommand,
    outputDirectory: preset.defaultOutputDirectory,
  };
}
