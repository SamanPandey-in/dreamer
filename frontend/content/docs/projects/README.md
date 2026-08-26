# Projects & the Import Wizard

A `Project` is the persistent record of "this GitHub repo, deployed to
Dreamer" — it's created once, through a multi-step wizard, and every
subsequent `Deployment` (each individual build+release) belongs to it.

## The wizard, step by step

```
1. RepoPicker              — pick a repo from the user's GitHub account
2. RootDirectoryPicker     — pick a root directory (lazy-loaded — see
                              framework-detection docs)
3. BuildConfigForm         — confirm/override the auto-detected framework,
                              install/build commands, output directory
4. NewProjectEnvVarsForm   — add environment variables
        │
        ▼
   POST /api/projects  →  a Project row exists
```

Each step is a separate frontend component
(`components/new-project/{RepoPicker,RootDirectoryPicker,BuildConfigForm,
NewProjectEnvVarsForm}.tsx`) — nothing is written to the database until
the very last step submits. Steps 2–3 call the framework-detection API
(`POST /api/build-config/detect`) to pre-fill sensible defaults; see
[`framework-detection/README.md`](../framework-detection/README.md) for
exactly how that detection works and how a user overrides it.

## Slugs: the project's public identity

`Project.slug` is what shows up in the dashboard, and — for a **static**
deployment specifically — it's also the literal S3 key prefix every
build uploads to (`__outputs/{slug}/`). Getting slug generation right
matters more than it might look like.

**The slug is derived from the project's name, not random.**
`slugifyProjectName("My Vite App")` → `"my-vite-app"` — lowercased,
non-alphanumeric runs collapsed to single hyphens, capped at 63
characters (`Project.slug` is `@db.VarChar(63)` — the actual DNS label
length limit, since this string becomes part of a real hostname).

```ts
function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ''); // re-trim in case the length cap landed mid-hyphen

  return slug || 'project'; // name was entirely emoji/non-Latin — still needs a valid slug
}
```

**Collisions fall back to a random suffix, not an error.** If
`"my-vite-app"` is already taken, `generateUniqueProjectSlug` retries as
`my-vite-app-a1b2c3` (a short hex suffix from `crypto.randomBytes`, not
`Math.random()` — no real security requirement here, it's just already
imported elsewhere and there's no reason to reach for a weaker
generator). The common case — a name nobody's used yet — gets a clean
slug; a collision degrades gracefully instead of blocking project
creation.

**A fixed set of reserved words can never be claimed**: `www`, `api`,
`app`, `admin`, `dashboard`, `staging`, `static`. A project named "API"
silently becomes `api-a1b2c3` instead of colliding with (or, worse,
actually claiming) a subdomain the platform itself might need later.

This is deliberately scoped to **project** slugs only —
`Deployment.slug` (the thing that's actually live at a subdomain, per
deployment) uses `random-word-slugs` and is never derived from anything
a user typed. See
[`deployments/overview.md`](../deployments/overview.md).

## What gets stored, and when

`createProject` writes a **snapshot**, not a live pointer back to the
detector:

```ts
detectedFramework: preset?.frameworkEnum ?? 'UNKNOWN',
detectedDeploymentType: preset?.deploymentType ?? 'STATIC',
rootDirectory: input.rootDirectory,
buildCommand: input.buildCommand,
installCommand: input.installCommand,
outputDirectory: input.outputDirectory,
```

If framework detection logic improves later (a new preset added, a
smarter check for an existing one), already-created projects keep
whatever config they were actually built with — they don't silently
change behavior underneath a project that's already deployed and working.
A user can always go update these explicitly in Settings.

## Ownership

Every read/write goes through `findOwnedProject(projectId, userId)` —
`WHERE id = ? AND userId = ? AND deletedAt IS NULL`, wrapped so a
project that exists but belongs to someone else 404s exactly the same as
one that doesn't exist at all. This is deliberate: a 403 (vs. 404) on
someone else's project would confirm to an attacker that a given
project ID is valid, leaking information a 404 doesn't.

`assertProjectOwnership` is the one exception — exported specifically for
`deployment.service.ts` to call internally, returning the full row
(including fields like `repoUrl` that never appear on the public,
client-facing `PublicProject` shape). This function is for same-process,
internal use only; it's never wired to an HTTP route directly.

## Editing a project

`PATCH /api/projects/:id` — a fixed, explicit field list
(`name`, `description`, `defaultBranch`, `buildCommand`,
`installCommand`, `outputDirectory`, `rootDirectory`,
`autoDeployEnabled`). Notably **not** editable here: `slug` (changing it
would break every existing deployment's URL and any bookmarks/links to
it) and `repoUrl` (switching the underlying repo out from under an
existing project is a "create a new project" action, not an edit).

## Deleting a project

Soft delete — `deletedAt` is set, the row itself (and every `Deployment`,
`DeploymentLog`, `AuditLog` row that references it) stays intact. Only
`listProjectsForUser` filters `deletedAt: null`; the full history remains
queryable directly by ID if you ever need to investigate what a deleted
project was.

The one thing that **does** get actively cleaned up is the project's live
S3 output:

```ts
try {
  await deleteS3Prefix(`__outputs/${project.slug}/`);
} catch (err) {
  console.error(`[PROJECT_DELETE] Failed to clean up S3 prefix for project ${projectId}:`, err);
}
```

This is best-effort and non-blocking — an S3 hiccup logs an error but
never stops the delete itself; the user asked to delete a project, not
to block on MinIO being reachable right now. Without this cleanup step, a
**different** project that later happens to land on the same slug would
silently inherit the deleted project's stale files until its own first
deploy overwrites them.

## Endpoint reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/projects` | Create (final wizard step) |
| GET | `/api/projects` | List the current user's projects, each with its latest deployment |
| GET | `/api/projects/:id` | One project's full detail |
| PATCH | `/api/projects/:id` | Update settings |
| DELETE | `/api/projects/:id` | Soft delete + S3 cleanup |
