import type {
  GithubPushPayload,
  GithubInstallationPayload,
  GithubInstallationRepositoriesPayload,
} from '@api/webhooks/github-webhook.types';

export function buildFakePushPayload(overrides: Partial<GithubPushPayload> = {}): GithubPushPayload {
  return {
    ref: 'refs/heads/main',
    before: '0000000000000000000000000000000000000a',
    after: '1111111111111111111111111111111111111b',
    deleted: false,
    repository: { id: 555222, full_name: 'SamanPandey-in/demo-app' },
    installation: { id: 999111 },
    head_commit: {
      id: '1111111111111111111111111111111111111b',
      message: 'fix: correct build output path',
      author: { name: 'Saman Pandey', username: 'SamanPandey-in' },
    },
    pusher: { name: 'SamanPandey-in' },
    ...overrides,
  };
}

export function buildFakeInstallationPayload(
  overrides: Partial<GithubInstallationPayload> = {}
): GithubInstallationPayload {
  return {
    action: 'deleted',
    installation: { id: 999111, account: { login: 'SamanPandey-in', type: 'User' } },
    ...overrides,
  };
}

export function buildFakeInstallationRepositoriesPayload(
  overrides: Partial<GithubInstallationRepositoriesPayload> = {}
): GithubInstallationRepositoriesPayload {
  return {
    action: 'removed',
    installation: { id: 999111 },
    repositories_removed: [{ id: 555222, full_name: 'SamanPandey-in/demo-app' }],
    ...overrides,
  };
}
