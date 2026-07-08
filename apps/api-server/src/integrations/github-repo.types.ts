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
