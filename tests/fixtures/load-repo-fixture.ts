import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DetectionInput, NextConfigLookup, PackageJsonShape } from '@api/build-config/framework-detector';

const FIXTURES_ROOT = fileURLToPath(new URL('./repos', import.meta.url));

const NEXT_CONFIG_FILENAMES = ['next.config.js', 'next.config.ts', 'next.config.mjs'];

export function loadRepoFixture(name: string): {
  rootFiles: string[];
  packageJson: PackageJsonShape | null;
  nextConfig: NextConfigLookup | undefined;
  detectionInput: DetectionInput;
} {
  const dir = path.join(FIXTURES_ROOT, name);
  if (!existsSync(dir)) {
    throw new Error(`Unknown repo fixture "${name}" — expected a directory at ${dir}`);
  }

  const rootFiles = readdirSync(dir);

  const packageJsonPath = path.join(dir, 'package.json');
  const packageJson: PackageJsonShape | null = existsSync(packageJsonPath)
    ? JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    : null;

  const nextConfigFilename = NEXT_CONFIG_FILENAMES.find((f) => rootFiles.includes(f));
  const nextConfig: NextConfigLookup | undefined = nextConfigFilename
    ? { filename: nextConfigFilename, source: readFileSync(path.join(dir, nextConfigFilename), 'utf8') }
    : undefined;

  return {
    rootFiles,
    packageJson,
    nextConfig,
    detectionInput: { rootFiles, packageJson },
  };
}
