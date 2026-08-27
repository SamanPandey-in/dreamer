export type PackageManagerId = 'npm' | 'yarn' | 'pnpm' | 'bun';

export interface PackageManagerInfo {
  id: PackageManagerId;
  /**
   * `npm ci` hard-fails without an exact, present-and-matching lockfile —
   * correct for reproducible builds, wrong for a repo with no committed
   * lockfile at all. detectPackageManager() only ever returns the `ci`
   * variant when it found the lockfile that command actually needs.
   */
  installCommand: string;
}

const LOCKFILE_TO_PACKAGE_MANAGER: ReadonlyArray<{ lockfile: string; info: PackageManagerInfo }> = [
  { lockfile: 'pnpm-lock.yaml', info: { id: 'pnpm', installCommand: 'pnpm install --frozen-lockfile' } },
  { lockfile: 'yarn.lock', info: { id: 'yarn', installCommand: 'yarn install --frozen-lockfile' } },
  { lockfile: 'bun.lockb', info: { id: 'bun', installCommand: 'bun install' } },
  { lockfile: 'package-lock.json', info: { id: 'npm', installCommand: 'npm ci --legacy-peer-deps' } },
];

const DEFAULT_PACKAGE_MANAGER: PackageManagerInfo = { id: 'npm', installCommand: 'npm install' };

/**
 * `rootFiles` is the set of filenames at the chosen root directory (for a
 * monorepo: the lockfile that matters is whichever sits next to the
 * package.json being built). Checked in a fixed, deliberate order: pnpm/
 * yarn/bun all win over npm — npm's lockfile is generated as a side effect
 * by every tool even when it isn't actually in use, making it the weakest
 * signal.
 */
export function detectPackageManager(rootFiles: readonly string[]): PackageManagerInfo {
  const fileSet = new Set(rootFiles);
  const match = LOCKFILE_TO_PACKAGE_MANAGER.find(({ lockfile }) => fileSet.has(lockfile));
  return match?.info ?? DEFAULT_PACKAGE_MANAGER;
}
