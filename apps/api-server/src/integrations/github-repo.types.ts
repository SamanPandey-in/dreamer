import { z } from 'zod';

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

// NEW — the "any other publicly available GitHub repo" search bar.
export const searchPublicReposSchema = z.object({
  query: z.object({
    query: z.string().min(1).max(255).trim(),
  }),
});

export type SearchPublicReposQuery = z.infer<typeof searchPublicReposSchema>['query'];

// NEW — branch listing, shared by the wizard's branch picker and the
// project-settings "Production Branch" dropdown.
export const listBranchesSchema = z.object({
  query: z.object({
    repoFullName: z.string().min(1).max(512),
    // The picker needs to know which branch to flag as "default" in the
    // returned list — mirrors how listRepoDirectorySchema takes `branch` as
    // the ref to query, just for a different purpose here.
    defaultBranch: z.string().min(1).max(255).trim(),
  }),
});

export type ListBranchesQuery = z.infer<typeof listBranchesSchema>['query'];
