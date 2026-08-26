export type PackageManagerId = 'npm' | 'yarn' | 'pnpm' | 'bun';

export interface PackageManagerInfo {
  id: PackageManagerId;
  /**
   * `npm ci` requires an exact, present-and-matching lockfile or it hard
   * fails — correct for reproducible builds, but wrong for a repo that
   * doesn't have a committed lockfile at all. detectPackageManager() only
   * ever returns the `ci` variant when it found the lockfile that command
   * actually needs.
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
 * `rootFiles` is the set of filenames at the chosen root directory (NOT the
 * repo root for a monorepo — the lockfile that matters is whichever one
 * sits next to the package.json that's actually being built). Checked in a
 * fixed, deliberate order: if a repo somehow has more than one lockfile
 * (a half-finished migration between package managers), pnpm/yarn/bun all
 * win over npm — npm's lockfile is the one every tool generates as a
 * side effect even when it isn't the one actually in use, so it's the
 * weakest signal and goes last.
 */
export function detectPackageManager(rootFiles: readonly string[]): PackageManagerInfo {
  const fileSet = new Set(rootFiles);
  const match = LOCKFILE_TO_PACKAGE_MANAGER.find(({ lockfile }) => fileSet.has(lockfile));
  return match?.info ?? DEFAULT_PACKAGE_MANAGER;
}
