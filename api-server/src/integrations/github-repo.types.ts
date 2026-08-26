import { z } from 'zod';

// local-engine: no installationId anymore — repo access is a single
// operator-wide PAT (see docs/architecture/local-engine-auth-and-networking.md
// Decision 2). GET /api/github/repos takes no query params at all now; it's
// just "list everything the stored PAT can see."

export const searchPublicReposSchema = z.object({
  query: z.object({
    query: z.string().min(1).max(200).trim(),
  }),
});

export type SearchPublicReposQuery = z.infer<typeof searchPublicReposSchema>['query'];

export const listRepoDirectorySchema = z.object({
  query: z.object({
    repoFullName: z.string().min(1).max(512),
    branch: z.string().min(1).max(255).trim(),
    // Defaults to the repo root — matches the wizard's first call, before
    // the user has expanded any folder.
    path: z.string().max(1024).trim().default(''),
  }),
});

export type ListRepoDirectoryQuery = z.infer<typeof listRepoDirectorySchema>['query'];

export const listBranchesSchema = z.object({
  query: z.object({
    repoFullName: z.string().min(1).max(512),
    // The picker needs to know which branch to flag as "default" in the
    // returned list.
    defaultBranch: z.string().min(1).max(255).trim(),
  }),
});

export type ListBranchesQuery = z.infer<typeof listBranchesSchema>['query'];
