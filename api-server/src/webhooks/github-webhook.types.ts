import { z } from 'zod';

/**
 * The subset of GitHub's push event payload this handler actually reads —
 * deliberately narrow, same reasoning as integrations/github-repo.service.ts's
 * RepoEntry: GitHub's real payload has dozens of fields (commits[],
 * head_commit.author, compare URL, etc.) we never need, and narrowing here
 * means a future payload shape change can't silently break something
 * downstream that was never supposed to depend on it.
 *
 * local-engine: this is a plain classic repo webhook now, not an App-owned
 * one (see docs/architecture/local-engine-auth-and-networking.md Decision
 * 3) — no `installation` field to rely on anymore. `repository.id` alone
 * is the lookup key (github-webhook.service.ts's findProjectsForPush).
 */
export const githubPushPayloadSchema = z.object({
  ref: z.string(), // "refs/heads/main"
  before: z.string(),
  after: z.string(), // the commit SHA to build — see deployment.service.ts's createWebhookDeployment
  deleted: z.boolean().default(false), // true = this "push" was actually a branch delete
  repository: z.object({
    id: z.number(),
    full_name: z.string(),
  }),
  head_commit: z
    .object({
      id: z.string(),
      message: z.string().optional(),
      author: z.object({ name: z.string().optional(), username: z.string().optional() }).optional(),
    })
    .nullable()
    .optional(), // null on a branch-delete push
  pusher: z.object({ name: z.string().optional() }).optional(),
});

export type GithubPushPayload = z.infer<typeof githubPushPayloadSchema>;

/** GitHub's ping payload, sent once immediately after a repo's webhook is configured — no repository push info to act on. */
export const githubPingPayloadSchema = z.object({
  zen: z.string().optional(),
  hook_id: z.number().optional(),
});
