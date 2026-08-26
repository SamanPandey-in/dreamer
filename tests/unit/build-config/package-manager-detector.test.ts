import '../../setup/test-env';
import { describe, it, expect } from 'vitest';
import { detectPackageManager } from '@api/build-config/package-manager-detector';

describe('detectPackageManager', () => {
  it('detects pnpm from pnpm-lock.yaml and uses the frozen-lockfile install command', () => {
    const result = detectPackageManager(['pnpm-lock.yaml', 'package.json']);
    expect(result).toEqual({ id: 'pnpm', installCommand: 'pnpm install --frozen-lockfile' });
  });

  it('detects yarn from yarn.lock', () => {
    const result = detectPackageManager(['yarn.lock', 'package.json']);
    expect(result).toEqual({ id: 'yarn', installCommand: 'yarn install --frozen-lockfile' });
  });

  it('detects bun from bun.lockb', () => {
    const result = detectPackageManager(['bun.lockb', 'package.json']);
    expect(result).toEqual({ id: 'bun', installCommand: 'bun install' });
  });

  it('detects npm from package-lock.json and uses `npm ci`', () => {
    const result = detectPackageManager(['package-lock.json', 'package.json']);
    expect(result).toEqual({ id: 'npm', installCommand: 'npm ci --legacy-peer-deps' });
  });

  it('falls back to a plain `npm install` when no lockfile is present at all', () => {
    const result = detectPackageManager(['package.json', 'src']);
    expect(result).toEqual({ id: 'npm', installCommand: 'npm install' });
  });

  it('prefers pnpm/yarn/bun over a leftover package-lock.json from a half-migrated repo', () => {
    const result = detectPackageManager(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
    expect(result.id).toBe('pnpm');
  });

  it('is order-independent in the input array (matches by presence, not position)', () => {
    const result = detectPackageManager(['package.json', 'src', 'yarn.lock', 'README.md']);
    expect(result.id).toBe('yarn');
  });
});
