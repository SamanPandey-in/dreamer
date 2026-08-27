import { vi } from 'vitest';

export function createRedisMock() {
  return {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };
}
export type RedisMock = ReturnType<typeof createRedisMock>;

export function createBuildQueueMock() {
  return {
    add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
    getJob: vi.fn().mockResolvedValue(null),
  };
}
export type BuildQueueMock = ReturnType<typeof createBuildQueueMock>;

export function createGithubAppMock() {
  return {
    invalidateInstallationTokenCache: vi.fn(),
    getInstallationAccessToken: vi.fn().mockResolvedValue('ghs_mockInstallationToken'),
  };
}
export type GithubAppMock = ReturnType<typeof createGithubAppMock>;
