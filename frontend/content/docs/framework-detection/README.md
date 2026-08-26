# Framework Detection

This is the engine behind the wizard's "we figured out how to build your
app" moment — given a GitHub repo and a chosen root directory, it decides
what framework you're using, what install/build commands to run, and
where the build output ends up, with the least possible number of GitHub
API calls.

Three files do the actual work, each with one job:

- **`integrations/github-repo.service.ts`** — talks to GitHub. Nothing in
  here knows what a framework is.
- **`build-config/framework-detector.ts`** — the actual detection
  algorithm. Pure, synchronous, zero I/O — takes filenames and a parsed
  `package.json`, returns a preset.
- **`build-config/framework-presets.ts`** — the static table of every
  supported framework's defaults. The detector decides *which* preset;
  this file defines *what each preset means*.

## Repo fetching: lazy, not a full clone

The wizard never clones a repo just to show you a folder picker or
detect a framework. Everything goes through GitHub's **Contents API**,
one directory at a time:

```ts
export async function listRepoDirectory(
  accessToken: string,
  repoFullName: string,
  dirPath: string,
  ref: string
): Promise<RepoEntry[]>
```

The root-directory picker calls this **once per folder the user actually
expands** — not a recursive walk of the entire tree up front. A repo with
thousands of files costs the picker exactly as many API calls as the
number of folders a user actually clicked into, not one call per file in
the repo. This is the "lazy loading" the picker is built around: cheap
for a huge repo, and it naturally respects GitHub's API rate limits
instead of trying to prefetch everything speculatively.

Two more targeted fetches happen once a root directory is chosen (not
per-keystroke, not speculatively):

- `fetchPackageJson` — only if `package.json` is actually present in the
  listing already returned by `listRepoDirectory` (checked via
  `rootFiles.includes('package.json')` — no wasted round trip guessing).
- `fetchRepoFile` for `next.config.*` — **only when a Next.js config file
  was found** (`needsNextConfigSource`). Every other framework's
  detection never needs a second file read at all; this one extra fetch
  exists solely to answer "is this a static export or an SSR build,"
  which can't be known from the file's mere presence — see below.

```
GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
```
is the one GitHub endpoint every one of these functions is a thin,
type-safe wrapper around — narrowed deliberately to `{ name, path, type }`
(dropping the dozen-plus other fields GitHub actually returns), so a
future GitHub API response shape change can't silently leak unexpected
fields through to the frontend.

## The preset table

`FRAMEWORK_PRESETS` is a flat lookup — one entry per supported framework,
each with a fixed shape:

```ts
interface FrameworkPreset {
  id: FrameworkPresetId;
  label: string;                       // shown in the dropdown
  deploymentType: 'STATIC' | 'DYNAMIC';
  frameworkEnum: Framework;            // the Prisma DB enum this maps onto
  defaultInstallCommand: string;
  defaultBuildCommand: string;
  defaultOutputDirectory: string;
  requiresUnsupportedRuntime: boolean; // blocks/warns in the wizard when true
}
```

| Preset | Deployment type | Output dir |
|---|---|---|
| `nextjs-static` | STATIC | `out` |
| `nextjs-ssr` | DYNAMIC | `.next` |
| `vite` | STATIC | `dist` |
| `cra` | STATIC | `build` |
| `angular` | STATIC | `dist` |
| `gatsby` | STATIC | `public` |
| `sveltekit` | STATIC | `build` |
| `astro` | STATIC | `dist` |
| `nuxt` | DYNAMIC | `.output/public` |
| `vue-cli` | STATIC | `dist` |
| `static` | STATIC | `.` (the fallback — "we couldn't detect anything") |

Two entries are worth calling out specifically:

- **`nextjs-static` vs. `nextjs-ssr` are two different presets sharing one
  framework** — the *same* `next.config.js` can produce either a fully
  static export or a server-rendered build; they're not distinguishable
  by dependency alone. See the detector section below for how this gets
  resolved.
- **`angular`'s `defaultOutputDirectory` is a deliberate guess, not a
  confident answer.** Real Angular CLI output nests under
  `dist/<project-name>` — a segment this system has no way to know without
  actually parsing `angular.json`. Rather than guess a project name it
  doesn't have, the preset ships a plausible default and leaves it for
  the user to confirm or correct in the wizard.

Every preset intentionally defaults `requiresUnsupportedRuntime: false`
today (this used to be `true` for `nextjs-ssr` before dynamic
SSR support existed — see
[`../deployments/dynamic-deployments.md`](../deployments/dynamic-deployments.md)).
`nuxt` is currently the one framework still flagged
`requiresUnsupportedRuntime: true` — Nuxt/Vue's dynamic runtime isn't
wired up yet, so the wizard surfaces a blocking notice instead of
silently producing a deployment that builds successfully and then 404s
on every route.

## The detection algorithm

`detectFramework()` is pure and synchronous — no network calls, just
filenames and an already-fetched `package.json` in, one `DetectionResult`
out. It checks signals in a fixed order, strongest first:

```
1. A framework-specific CONFIG FILE at the chosen root
      next.config.{js,ts,mjs} → Next.js (see the static/SSR split below)
      vite.config.{js,ts,mjs} → Vite
      angular.json             → Angular
      gatsby-config.{js,ts}    → Gatsby
      svelte.config.js         → SvelteKit
      astro.config.{js,ts,mjs} → Astro
      nuxt.config.{js,ts}      → Nuxt
         ↓ none of the above found
2. package.json DEPENDENCIES (a weaker signal, but still reliable)
      next, vite, react-scripts, @angular/core, gatsby,
      @sveltejs/kit, astro, nuxt/nuxt3, vue + @vue/cli-service
         ↓ nothing matched
3. The `static` preset — an explicit "we don't know," never a guess
   dressed up as a confident answer
```

**Why config files are checked before dependencies.** A config file can't
lie about what build tool is actually wired up — if `vite.config.ts`
exists, Vite is genuinely building this project, full stop, regardless
of what happens to be listed (or not listed, in an unusual monorepo
hoisting setup) in `package.json`. Dependencies are one level less
certain: a leftover dependency from a migration, or a dependency hoisted
up from a workspace root, can point at a framework that isn't actually
what builds this specific package. Config-file presence wins whenever
both signals are available.

### The Next.js static-export split

This is the one genuinely tricky case in the whole detector, because a
single config file's mere *presence* doesn't answer the question that
actually matters — "static or SSR?" That requires reading the file's
contents:

```ts
function isNextStaticExport(nextConfigSource: string | null): boolean {
  if (!nextConfigSource) return false;
  return /output\s*:\s*['"]export['"]/.test(nextConfigSource);
}
```

This is deliberately a **regex, not a real JS/TS parse**.
`next.config.js` can be CJS, ESM, or TypeScript — a full parse to extract
one config key is a lot more failure surface (three different module
systems, three different sets of syntax edge cases) than this single
boolean is worth. The tradeoff: a config that sets `output` dynamically
(read from an environment variable, computed at build time) won't be
caught by this check.

That tradeoff is deliberately resolved toward the *safer* wrong answer.
A repo with a dynamically-set `output` falls through to the `nextjs-ssr`
preset — which surfaces "this needs the dynamic runtime" as a clear
notice in the wizard, rather than confidently defaulting to `static` and
producing a deployment that builds "successfully" and then silently
serves a broken site with no routes working. Being wrong in the direction
of "asks you to confirm" beats being wrong in the direction of "looks
like it worked."

## Package manager detection

A second, independent detector runs alongside framework detection —
which install command to actually use:

```ts
const LOCKFILE_TO_PACKAGE_MANAGER = [
  { lockfile: 'pnpm-lock.yaml',    info: { id: 'pnpm', installCommand: 'pnpm install --frozen-lockfile' } },
  { lockfile: 'yarn.lock',         info: { id: 'yarn', installCommand: 'yarn install --frozen-lockfile' } },
  { lockfile: 'bun.lockb',         info: { id: 'bun',  installCommand: 'bun install' } },
  { lockfile: 'package-lock.json', info: { id: 'npm',  installCommand: 'npm ci --legacy-peer-deps' } },
];
```
Falls back to plain `npm install` if no lockfile is present at all.

**Why `npm ci` requires finding the lockfile first, rather than being the
default.** `npm ci` demands an exact, present, matching lockfile or it
hard-fails outright — correct for reproducible builds when a lockfile
exists, completely wrong as a blind default for a repo that never
committed one. `detectPackageManager()` only ever returns the `ci`
variant when it actually found the lockfile that command needs to
succeed.

**Why npm's lockfile is checked last, not first.** If a repo somehow has
more than one lockfile present (a half-finished migration between
package managers), pnpm/yarn/bun all win. `package-lock.json` is the
file nearly every tool generates as a side effect even when it isn't the
one actually in active use — it's the weakest signal of the four, so it
only wins when nothing else is present at all.

Framework and package-manager detection are **independent axes** —
framework tells you *what* to build (the build command, the output
directory), the lockfile tells you *how* to install dependencies. A
Vite project installed with pnpm gets Vite's `buildCommand`/
`outputDirectory` and pnpm's `installCommand`, combined.

## Detection output is a draft, not a write

`resolveDetectedBuildConfig()` — the function `POST
/api/build-config/detect` actually calls — **never touches the
database**. It returns a plain object:

```ts
interface DetectedBuildConfig {
  framework: { id, label, deploymentType, requiresUnsupportedRuntime };
  matchedOn: string | null;   // e.g. "next.config.js", or "package.json (vite dependency)"
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
}
```

This becomes the wizard's **editable form state** — pre-filled input
boxes, not a locked-in decision. `matchedOn` specifically exists to make
detection legible to the user (and, later, useful for improving
detection quality): "Detected via `next.config.js`" reads very
differently than an unexplained "Detected: Next.js" would, and knowing
whether real-world repos get caught by the config-file check or fall
through to the dependency check is exactly the kind of signal worth
keeping even before there's a UI surface consuming it.

## Editable, and re-selecting a preset doesn't re-hit GitHub

Two related UX details worth understanding as one piece: the wizard's
install/build/output fields start pre-filled from detection but are
plain editable inputs the whole time, and — this is the part that's easy
to miss reading only the frontend — **manually switching the "Application
Preset" dropdown to a different framework does NOT call `/detect` again.**

```
GET /api/build-config/presets   (called once, when the wizard mounts)
      → the full preset table, with every preset's defaults

user picks a different preset from the dropdown
      → frontend re-fills install/build/output fields from the
        ALREADY-FETCHED presets list, entirely client-side
```

Switching presets is a local, instant UI action — there's no reason to
wait on a fresh GitHub API round trip just because the user decided they
actually know better than the auto-detected guess. `/detect` is only
ever called once per root-directory selection, not once per dropdown
change.

Nothing about any of this is committed until the wizard's final step —
see [`../projects/README.md`](../projects/README.md) for what actually
gets written to `Project` once the user submits, and why it's a snapshot
rather than a live pointer back to this detector.
