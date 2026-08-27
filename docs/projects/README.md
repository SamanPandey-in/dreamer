# Projects & the Import Wizard

A `Project` is the persistent record of "this GitHub repo, deployed to
this instance" — it's created once, through a multi-step wizard, and every
subsequent `Deployment` (each individual build+release) belongs to it.

## The wizard, step by step

```
1. RepoPicker              — pick a repo from your own GitHub account
                             (listed via the stored Personal Access Token)
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
exactly how that detection works and how you override it.

The repo picker lists repos through GitHub's plain `GET /user/repos`,
authenticated with the one operator-wide Personal Access Token set in
Settings → Git (see [`auth/README.md`](../auth/README.md)) — no per-repo
installation step, no OAuth flow inside the wizard.

## Slugs: the project's public identity

`Project.slug` is what shows up in the dashboard, and — for a **static**
deployment specifically — it's also the literal object-store key prefix
every build uploads to (`__outputs/{slug}/`). Getting slug generation
right matters more than it might look like.

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
`Deployment.slug` (the thing that identifies one specific build) uses
`random-word-slugs` and is never derived from anything a user typed. See
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
You can always go update these explicitly in Settings.

## Ownership

Every read/write goes through `findOwnedProject(projectId, userId)` —
`WHERE id = ? AND userId = ? AND deletedAt IS NULL`, wrapped so a project
that exists but isn't yours 404s exactly the same as one that doesn't
exist at all.

With a single admin account this check rarely has anyone to distinguish
*from* — but it stays, deliberately. Sessions are revocable credentials,
not identity proofs; defense in depth here costs one query predicate and
means a compromised or stale session can only ever touch rows actually
owned by the account it authenticated as. The same reasoning keeps the
404-not-403 behavior: confirming that a given project ID is valid leaks
information a uniform 404 doesn't.

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

Two consequences fall out of that immediately:

- The project stops resolving **at once**, with zero extra teardown work:
  `reverse-proxy`'s lookup joins on `deletedAt IS NULL`
  (see [`reverse-proxy/README.md`](../reverse-proxy/README.md)), so its
  subdomain starts returning 404s the moment the flag is set.
- The one thing that **does** get actively cleaned up is the project's
  live static output in MinIO:

```ts
try {
  await deleteS3Prefix(`__outputs/${project.slug}/`);
} catch (err) {
  console.error(`[PROJECT_DELETE] Failed to clean up output prefix for project ${projectId}:`, err);
}
```

This is best-effort and non-blocking — an object-store hiccup logs an
error but never stops the delete itself; you asked to delete a project,
not to block on storage being reachable right now. Without this cleanup
step, a **different** project that later happens to land on the same slug
would silently inherit the deleted project's stale files until its own
first deploy overwrites them.

## Endpoint reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/projects` | Create (final wizard step) |
| GET | `/api/projects` | List your projects, each with its latest deployment |
| GET | `/api/projects/:id` | One project's full detail |
| PATCH | `/api/projects/:id` | Update settings |
| DELETE | `/api/projects/:id` | Soft delete + output-prefix cleanup |
