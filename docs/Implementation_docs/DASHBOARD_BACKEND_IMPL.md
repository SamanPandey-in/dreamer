# Dreamer Dashboard — Backend (Projects + Deployments + Realtime), End-to-End

This is the production-grade backend half of the Vercel-style dashboard: everything needed to create
a project, trigger a deployment, watch it build in real time, and read back its history — built
against your **actual** repo as it exists today (the real `schema.prisma`, the real `auth/` feature
folder, the real `app.ts`/`index.ts`). Auth stays untouched with exactly **one approved exception** —
a single-line OAuth scope widening in `github.service.ts`, needed for private-repo deploys and signed
off explicitly (see §3.7) — every other file below is either brand new or a surgical, explained edit to
`app.ts`/`index.ts`/`build-engine`.

Zero new dependencies. `@aws-sdk/client-ecs`, `ioredis`, `socket.io`, `zod`, `random-word-slugs` are
already in `apps/api-server/package.json` — they were installed for the original prototype and are
exactly what this needs.

---

## 0. The architecture, and why

### 0.1 What already exists that this builds on

Three things in your repo were *designed* for this dashboard before the dashboard existed:

1. **`prisma/schema.prisma`** already has `Project`, `Deployment`, `DeploymentStateTransition`,
   `DeploymentLog`, with denormalized `Project.activeDeploymentId` / `Project.lastDeployedAt`
   fields whose comment literally says *"cached for dashboard query performance"*. No migration
   needed for anything below.
2. **`app.ts`'s `/api/deploy`** already fires a real `ECS RunTaskCommand`. It just never writes a
   `Project`/`Deployment` row, never reports status back, and isn't behind auth.
3. **`index.ts`'s Socket.IO + Redis subscriber** already relays `logs:*` Redis pub/sub messages to
   socket rooms, and `apps/build-engine/script.js` already publishes to `logs:{id}`. The dashboard's
   "live updating status badges and log lines" requirement is *already half-built* — it's just keyed
   by project slug instead of deployment ID, carries unstructured strings instead of structured
   events, and has zero authorization on who can subscribe to what.

So this guide is not "bolt SSE onto a REST API." It's "finish what's already there, with auth and
persistence." That distinction matters for the rest of the decisions below.

### 0.2 Why Socket.IO + Redis pub/sub stays, and SSE doesn't get introduced

Some PaaS write-ups (including planning notes you may have seen floating around for this project)
argue for replacing Socket.IO with Server-Sent Events — simpler protocol, no extra port, auto-reconnect
over plain HTTP. That's a reasonable opinion **in a vacuum**. It is the wrong call **here**, for one
concrete reason: `apps/frontend/app/demo/page.tsx` and `apps/api-server/src/index.ts` already have a
working, tested Socket.IO pipeline end-to-end. Ripping it out to switch transports is a rewrite with
zero functional benefit to the dashboard you asked for. The actual production-grade move is to take
the prototype's transport and harden everything *around* it: authorization, structured payloads,
durable persistence. That's what Part 3 (Realtime) below does.

### 0.3 The end-to-end flow this builds

```
 ┌──────────┐  POST /api/projects                ┌──────────────┐
 │ Frontend │ ───────────────────────────────────▶│  projects/   │── Project row
 │          │                                      │  feature     │
 │          │  POST /api/projects/:id/deployments  └──────────────┘
 │          │ ───────────────────────────────────▶┌──────────────┐
 │          │                                      │ deployments/ │── Deployment row (QUEUED)
 │          │                                      │  feature     │── DeploymentStateTransition row
 │          │                                      └──────┬───────┘
 │          │                                             │ deploymentEngine.launchBuildTask()
 │          │                                             ▼
 │          │                                      ┌──────────────┐
 │          │                                      │  ECS Fargate │
 │          │                                      │  RunTask     │
 │          │                                      └──────┬───────┘
 │          │                                             │ git clone, npm build, S3 upload
 │          │                                             │ publishes to Redis: deployment:{id}
 │          │                                             ▼
 │          │                                      ┌──────────────┐
 │          │   socket.io: 'log' / 'status' events │   realtime/  │── persists DeploymentLog rows
 │          │ ◀────────────────────────────────────│   gateway    │── calls transitionDeploymentStatus()
 └──────────┘                                      └──────────────┘
```

Every arrow above is a file in this guide. By the end, a user can: import a repo → watch it queue,
build, and go live, with logs streaming in real time → see it on their dashboard with a live status
badge → click into any past deployment and see exactly what happened and when.

### 0.4 Feature-folder layout (matches your existing convention exactly)

```
apps/api-server/src/
├── auth/                          # UNTOUCHED, except one approved line — see §3.7
│   ├── auth.controller.ts
│   ├── auth.middleware.ts
│   ├── auth.routes.ts
│   ├── auth.service.ts
│   ├── auth.tokens.ts
│   ├── auth.types.ts
│   ├── github.service.ts          # EDITED — OAuth scope widened by one string, for private-repo deploys
│   └── index.ts
│
├── projects/                      # NEW
│   ├── project.controller.ts
│   ├── project.routes.ts
│   ├── project.service.ts
│   ├── project.types.ts
│   └── index.ts
│
├── deployments/                   # NEW
│   ├── deployment.controller.ts
│   ├── deployment-engine.ts       # ECS adapter behind a small interface (DIP — see §5)
│   ├── deployment.routes.ts
│   ├── deployment.service.ts
│   ├── deployment.types.ts
│   └── index.ts
│
├── realtime/                      # NEW — not a REST feature, no controller/routes;
│   ├── log-relay.ts               # it's a background Redis subscriber + Socket.IO gateway
│   ├── realtime.types.ts
│   ├── socket.server.ts
│   └── index.ts
│
├── lib/
│   ├── audit.ts                   # NEW — shared audit-log writer (was private to auth.service.ts)
│   ├── ecs-client.ts              # NEW — singleton ECSClient, moved out of app.ts
│   ├── redis.ts                   # NEW — singleton ioredis client for ordinary commands
│   ├── crypto.ts / env.ts / errors.ts / prisma.ts   # UNTOUCHED
│
├── middleware/                    # UNTOUCHED — validate.middleware.ts, rate-limiter, error-handler
├── app.ts                         # EDITED — mounts the two new routers, removes the old inline /api/deploy
└── index.ts                       # EDITED — now just boots app.listen() + the realtime gateway
```

`realtime/` deliberately has no `.controller.ts` / `.routes.ts` files — there is no HTTP route here at
all, so naming it like a REST feature would be misleading. It keeps the same *folder-per-concern*
spirit your `auth/` folder established, just without forcing a shape that doesn't fit.

### 0.5 A deliberate module-boundary rule, worth internalizing

`deployment.service.ts` needs to check that a project belongs to the user before creating a
deployment under it. The obvious thing to write is:

```ts
import { assertProjectOwnership } from '../projects'; // the barrel
```

**Don't.** `projects/index.ts` re-exports `project.routes.ts`, which (as you'll see in §2) imports
`projectDeploymentsRouter` from `deployments/index.ts`, which exports `deployment.routes.ts`, whose
controller imports `deployment.service.ts` — which would import `projects/index.ts` right back. That's
a circular `require` graph. Node.js half-tolerates these (you get partially-initialized modules
depending on import order) which makes it a bug that only shows up sometimes, usually in production
under a different module-resolution order than your dev machine used.

The fix used throughout this guide: **when one feature needs another feature's internals, import the
concrete file, never the barrel.**

```ts
import { assertProjectOwnership } from '../projects/project.service'; // ✅ no cycle
```

`project.service.ts` has zero imports from `deployments/`, so this direction is safe. Keep that
asymmetry in mind if you extend either feature later — the dependency only ever points one way
(deployments → projects), and that's by design, not accident: a deployment can't exist without a
project, but a project's existence has no idea deployments exist.

---

## 1. Shared `lib/` additions

Three small, boring files. Each follows the exact pattern `lib/prisma.ts` already established: one
singleton client, constructed once at import time, imported everywhere instead of re-constructed.

### 1.1 `src/lib/ecs-client.ts`

The `ECSClient` instance was previously constructed inline at the top of `app.ts`. It moves here
unchanged — same rationale as `lib/prisma.ts`: construct the AWS SDK client once per process, not
once per request.

```typescript
// src/lib/ecs-client.ts
import { ECSClient } from '@aws-sdk/client-ecs';
import { env } from './env';

// One ECS client for the lifetime of the process — same rationale as lib/prisma.ts:
// the SDK manages its own credential resolution and connection pooling
// internally, so constructing a new client per request (or per deployment)
// is pure waste, and for credential providers that hit STS, can even get you
// rate-limited under load.
export const ecsClient = new ECSClient({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});
```

### 1.2 `src/lib/redis.ts`

`index.ts` previously created its own ad-hoc `new Redis(env.REDIS_URL)` for the pub/sub subscriber.
That connection is *only* allowed to run `(p)subscribe` once it's in subscriber mode — ioredis
connections cannot mix ordinary commands (`INCR`, `GET`, ...) with subscribe mode on the same socket.
This file is the **general-purpose** client (used by `deployment.service.ts` for `INCR` below); the
realtime gateway's dedicated subscriber connection is created separately, inside `realtime/log-relay.ts`.

```typescript
// src/lib/redis.ts
import Redis from 'ioredis';
import { env } from './env';

// One general-purpose Redis connection for ordinary commands (INCR, EXPIRE,
// etc.) shared across services. Never used for (p)subscribe — a Redis
// connection that has called subscribe() can no longer run other commands,
// so pub/sub gets its own dedicated connection (see src/realtime/log-relay.ts).
export const redis = new Redis(env.REDIS_URL);
```

### 1.3 `src/lib/audit.ts`

`auth.service.ts` has its own private `audit()` helper writing to `AuditLog`. Per your instruction,
that file is untouched. But `project.service.ts` and `deployment.service.ts` both need the exact same
capability ("who did what, when, from where") — copy-pasting the helper into two more files would
violate DRY for no reason. This is the shared version they both use.

```typescript
// src/lib/audit.ts
import { prisma } from './prisma';
import type { Prisma } from '../generated/prisma/client';

export interface AuditMeta {
  ipAddress?: string;
  userAgent?: string;
}

interface AuditOptions {
  resourceType?: string;
  resourceId?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Shared AuditLog writer for everything outside auth/ (which keeps its own
 * private copy — not migrated here, since auth.service.ts is explicitly
 * off-limits for this change). If you ever do want to de-duplicate that one
 * too, it's a drop-in swap: same signature, same table.
 */
export async function audit(
  userId: string | null,
  action: string,
  meta: AuditMeta = {},
  options: AuditOptions = {}
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId,
      action,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      metadata: options.metadata,
    },
  });
}
```

---

## 2. The `projects/` feature

### 2.1 `src/projects/project.types.ts`

Same shape as `auth/auth.types.ts`: zod schemas first (request validation), then the DTOs
(`PublicProject` etc.) that the service layer returns and the controller serializes — never the raw
Prisma row, same reasoning as `auth.types.ts`'s `PublicUser` (never leak `passwordHash`; here, never
leak nothing-sensitive-yet, but the discipline is worth keeping consistent from day one. The moment
`webhookSecret` gets added to a response by accident because "it's just one more project field" is the
moment this discipline pays for itself).

```typescript
// src/projects/project.types.ts
import { z } from 'zod';

export const createProjectSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255).trim(),
    repoUrl: z.url().max(2048),
    // Defaults to 'main' in the service layer, not here — keeping the
    // "what's the actual default" logic in one place (project.service.ts)
    // rather than splitting it between a zod .default() and a service
    // fallback that could drift out of sync.
    defaultBranch: z.string().min(1).max(255).trim().optional(),
    description: z.string().max(500).trim().optional(),
    isPrivate: z.boolean().optional(),
  }),
});

export const updateProjectSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  body: z.object({
    name: z.string().min(1).max(255).trim().optional(),
    description: z.string().max(500).trim().optional(),
    defaultBranch: z.string().min(1).max(255).trim().optional(),
  }),
});

export const projectIdParamSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>['body'];
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>['body'];

/** Shape returned to the client for a project — never repoFullName-derivation internals, webhookSecret, etc. */
export interface PublicProject {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  repoUrl: string;
  repoFullName: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  activeDeploymentId: string | null;
  lastDeployedAt: Date | null;
  createdAt: Date;
}

/**
 * Deliberately a hand-written, narrow type — NOT an import from
 * deployments/deployment.types.ts. Keeping deployments/ at arm's length from
 * projects/ here (a structural duplicate of a few fields, instead of a
 * cross-feature import) is what keeps the module graph a DAG. See §0.5.
 */
export interface LatestDeploymentSummary {
  id: string;
  slug: string;
  status: string;
  url: string | null;
  branch: string;
  commitMessage: string | null;
  createdAt: Date;
}

export interface ProjectWithLatestDeployment extends PublicProject {
  deploymentCount: number;
  latestDeployment: LatestDeploymentSummary | null;
}
```

### 2.2 `src/projects/project.service.ts`

```typescript
// src/projects/project.service.ts
import { randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';
import { audit, type AuditMeta } from '../lib/audit';
import { ConflictError, NotFoundError } from '../lib/errors';
import type {
  CreateProjectInput,
  LatestDeploymentSummary,
  ProjectWithLatestDeployment,
  PublicProject,
  UpdateProjectInput,
} from './project.types';
import type { Project } from '../generated/prisma/client';

const MAX_SLUG_LENGTH = 63; // Project.slug is @db.VarChar(63) — a DNS label limit
const SLUG_SUFFIX_LENGTH = 6; // "-a1b2c3" — short enough to stay readable, long enough that two retries colliding is effectively impossible
const SLUG_MAX_ATTEMPTS = 5;

// A handful of subdomains/paths that would be confusing or actively
// dangerous for a user to claim as their own project's identifier — checked
// the same way a taken slug is, so a user who names their project "API"
// silently gets "api-a1b2c3" instead of a 500 or, worse, actually claiming it.
const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'dashboard', 'staging', 'static']);

/**
 * Matches https://github.com/owner/repo(.git) and git@github.com:owner/repo.git.
 * repoFullName exists on the schema specifically so the (future) GitHub
 * webhook handler can do `WHERE repoFullName = payload.repository.full_name`
 * instead of string-matching repoUrl — see the index comment in schema.prisma.
 * Parsing it once, at creation time, means that lookup is ready the moment
 * webhooks get built, with zero migration.
 */
function parseRepoFullName(repoUrl: string): string | null {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function toPublicProject(project: Project): PublicProject {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    repoUrl: project.repoUrl,
    repoFullName: project.repoFullName,
    defaultBranch: project.defaultBranch,
    isPrivate: project.isPrivate,
    activeDeploymentId: project.activeDeploymentId,
    lastDeployedAt: project.lastDeployedAt,
    createdAt: project.createdAt,
  };
}

/**
 * "My Vite App" -> "my-vite-app". Lowercase, non-alphanumeric runs collapsed
 * to a single hyphen, leading/trailing hyphens trimmed, hard-capped at the
 * DNS label limit. Falls back to a fixed string for the edge case where the
 * name has no ASCII alphanumeric characters at all (e.g. a name that's
 * entirely emoji or non-Latin script) — the random-suffix fallback below
 * still makes that project's slug unique, it just won't be "named" by this
 * function alone.
 */
function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ''); // re-trim in case the length cap landed mid-hyphen

  return slug || 'project';
}

function randomSlugSuffix(): string {
  // crypto.randomBytes, not Math.random() — not because this needs to be
  // cryptographically unguessable (it's a disambiguation suffix, not a
  // secret), but because Node's CSPRNG is already imported by lib/crypto.ts
  // elsewhere in this codebase and there's no reason to reach for a weaker
  // generator just because the stakes here happen to be lower.
  return randomBytes(Math.ceil(SLUG_SUFFIX_LENGTH / 2))
    .toString('hex')
    .slice(0, SLUG_SUFFIX_LENGTH);
}

async function isSlugAvailable(slug: string): Promise<boolean> {
  if (RESERVED_SLUGS.has(slug)) return false;
  const existing = await prisma.project.findUnique({ where: { slug } });
  return !existing;
}

/**
 * The project's slug IS its name, slugified — not a random string unrelated
 * to what the user actually called their project. This is what shows up on
 * the dashboard card under the project name (§2.3 of the frontend guide) and
 * it should read as "the project's identifier," not "a dice roll." A random
 * suffix only ever appears as a fallback, and only on the exact name that
 * collided — so the common case (a project name nobody else has used yet)
 * gets a clean slug, and collisions degrade gracefully instead of erroring.
 *
 * This is deliberately scoped to PROJECT slugs only. Deployment.slug (see
 * deployment.service.ts) stays on random-word-slugs unchanged — a
 * deployment isn't named by the user, and Deployment.slug is what actually
 * becomes the live subdomain, where "memorable" matters far less than "the
 * project's slug is what a human looks at on the dashboard."
 */
async function generateUniqueProjectSlug(name: string): Promise<string> {
  const base = slugifyProjectName(name);

  if (await isSlugAvailable(base)) return base;

  // Collision (or a reserved word) — fall back to `base-xxxxxx`. Truncate
  // the base first so the suffixed candidate still fits inside
  // MAX_SLUG_LENGTH even when `base` was already near the limit on its own.
  const truncatedBase = base.slice(0, MAX_SLUG_LENGTH - (SLUG_SUFFIX_LENGTH + 1));

  for (let attempt = 0; attempt < SLUG_MAX_ATTEMPTS; attempt++) {
    const candidate = `${truncatedBase}-${randomSlugSuffix()}`;
    if (await isSlugAvailable(candidate)) return candidate;
  }

  throw new ConflictError(
    'Could not generate a unique project slug — please try again',
    'SLUG_GENERATION_FAILED'
  );
}

export async function createProject(
  userId: string,
  input: CreateProjectInput,
  meta: AuditMeta
): Promise<PublicProject> {
  const slug = await generateUniqueProjectSlug(input.name);

  const project = await prisma.project.create({
    data: {
      userId,
      name: input.name,
      slug,
      description: input.description,
      repoUrl: input.repoUrl,
      repoFullName: parseRepoFullName(input.repoUrl),
      defaultBranch: input.defaultBranch ?? 'main',
      isPrivate: input.isPrivate ?? false,
    },
  });

  await audit(userId, 'project.create', meta, { resourceType: 'project', resourceId: project.id });

  return toPublicProject(project);
}

/**
 * The dashboard home page query. One round trip for every project the user
 * owns, plus just enough of its most recent deployment to render a status
 * badge — no N+1 query per card. `take: 1` per project relies on the
 * `[projectId, createdAt(sort: Desc)]` index already defined on Deployment
 * in schema.prisma for exactly this access pattern.
 */
export async function listProjectsForUser(userId: string): Promise<ProjectWithLatestDeployment[]> {
  const projects = await prisma.project.findMany({
    where: { userId, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    include: {
      deployments: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          slug: true,
          status: true,
          url: true,
          branch: true,
          commitMessage: true,
          createdAt: true,
        },
      },
      _count: { select: { deployments: true } },
    },
  });

  return projects.map((project) => {
    const latest = project.deployments[0];
    const latestDeployment: LatestDeploymentSummary | null = latest
      ? {
          id: latest.id,
          slug: latest.slug,
          status: latest.status,
          url: latest.url,
          branch: latest.branch,
          commitMessage: latest.commitMessage,
          createdAt: latest.createdAt,
        }
      : null;

    return {
      ...toPublicProject(project),
      deploymentCount: project._count.deployments,
      latestDeployment,
    };
  });
}

async function findOwnedProject(projectId: string, userId: string): Promise<Project> {
  const project = await prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null } });
  if (!project) throw new NotFoundError('Project not found', 'PROJECT_NOT_FOUND');
  return project;
}

export async function getProjectById(projectId: string, userId: string): Promise<PublicProject> {
  return toPublicProject(await findOwnedProject(projectId, userId));
}

/**
 * Exported specifically for deployment.service.ts to call — see §0.5 for why
 * that import goes through this concrete file and never through
 * projects/index.ts. Returns the full row (not PublicProject) because
 * deployment.service.ts needs repoUrl and defaultBranch, which aren't on the
 * public DTO's typical client-facing shape but absolutely are here since
 * this function is for internal, same-process use only — never wire this up
 * to an HTTP route directly.
 */
export async function assertProjectOwnership(projectId: string, userId: string): Promise<Project> {
  return findOwnedProject(projectId, userId);
}

export async function updateProject(
  projectId: string,
  userId: string,
  input: UpdateProjectInput,
  meta: AuditMeta
): Promise<PublicProject> {
  await findOwnedProject(projectId, userId); // 404s before issuing the UPDATE

  const project = await prisma.project.update({
    where: { id: projectId },
    data: {
      name: input.name,
      description: input.description,
      defaultBranch: input.defaultBranch,
    },
  });

  await audit(userId, 'project.update', meta, {
    resourceType: 'project',
    resourceId: projectId,
    metadata: input,
  });

  return toPublicProject(project);
}

/**
 * Soft delete — keeps every Deployment/DeploymentLog/AuditLog row intact
 * (the FK is onDelete: Cascade only for a HARD delete; this never issues
 * one). Only listProjectsForUser filters deletedAt: null, so the history
 * stays queryable directly by ID if you ever need to investigate "what was
 * this project before it was deleted."
 */
export async function softDeleteProject(projectId: string, userId: string, meta: AuditMeta): Promise<void> {
  await findOwnedProject(projectId, userId);

  await prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
  await audit(userId, 'project.delete', meta, { resourceType: 'project', resourceId: projectId });
}
```

### 2.3 `src/projects/project.controller.ts`

```typescript
// src/projects/project.controller.ts
import type { Request, Response } from 'express';
import * as projectService from './project.service';
import type { AuditMeta } from '../lib/audit';

function auditMeta(req: Request): AuditMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

export async function createProjectHandler(req: Request, res: Response) {
  const project = await projectService.createProject(req.user!.id, req.body, auditMeta(req));
  res.status(201).json({ project });
}

export async function listProjectsHandler(req: Request, res: Response) {
  const projects = await projectService.listProjectsForUser(req.user!.id);
  res.status(200).json({ projects });
}

export async function getProjectHandler(req: Request, res: Response) {
  const project = await projectService.getProjectById(req.params.projectId, req.user!.id);
  res.status(200).json({ project });
}

export async function updateProjectHandler(req: Request, res: Response) {
  const project = await projectService.updateProject(req.params.projectId, req.user!.id, req.body, auditMeta(req));
  res.status(200).json({ project });
}

export async function deleteProjectHandler(req: Request, res: Response) {
  await projectService.softDeleteProject(req.params.projectId, req.user!.id, auditMeta(req));
  res.status(204).send();
}
```

### 2.4 `src/projects/project.routes.ts`

```typescript
// src/projects/project.routes.ts
import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { projectDeploymentsRouter } from '../deployments';
import {
  createProjectHandler,
  deleteProjectHandler,
  getProjectHandler,
  listProjectsHandler,
  updateProjectHandler,
} from './project.controller';
import { createProjectSchema, projectIdParamSchema, updateProjectSchema } from './project.types';

export const projectsRouter = Router();

// requireAuth is applied ONCE, where this router is mounted in app.ts —
// every route under /api/projects requires a logged-in user. Unlike
// /api/auth (where /register, /login, /github are intentionally public),
// nothing here ever is, so there's no per-route case to handle.

projectsRouter.post('/', validate(createProjectSchema), createProjectHandler);
projectsRouter.get('/', listProjectsHandler);
projectsRouter.get('/:projectId', validate(projectIdParamSchema), getProjectHandler);
projectsRouter.patch('/:projectId', validate(updateProjectSchema), updateProjectHandler);
projectsRouter.delete('/:projectId', validate(projectIdParamSchema), deleteProjectHandler);

// Composition, not duplication: deployments/ owns its own validation and
// handlers for everything under .../deployments; this router only owns
// where that sub-router gets mounted.
projectsRouter.use('/:projectId/deployments', projectDeploymentsRouter);
```

### 2.5 `src/projects/index.ts`

```typescript
// src/projects/index.ts
export { projectsRouter } from './project.routes';
export * from './project.types';
```

---

## 3. The `deployments/` feature

### 3.1 `src/deployments/deployment-engine.ts` — the DIP boundary

This is the one file in the whole guide written explicitly to demonstrate a SOLID principle, because
it's the place where it matters most: **deployment.service.ts must never import `@aws-sdk/client-ecs`
directly.** It depends on a small interface; one class implements that interface today.

```typescript
// src/deployments/deployment-engine.ts
import { RunTaskCommand } from '@aws-sdk/client-ecs';
import { ecsClient } from '../lib/ecs-client';
import { env } from '../lib/env';

/**
 * Everything deployment.service.ts needs from "whatever actually runs the
 * build" — and nothing more (Dependency Inversion: the high-level module
 * depends on this abstraction; the low-level AWS SDK detail depends on it
 * too, by implementing it — neither depends on the other directly).
 *
 * This interface is deliberately THIS small. It is not the full
 * sleep/wake/stop/getStatus surface the platform will eventually need for
 * scale-to-zero — adding unimplemented methods now would be speculative
 * complexity (the inverse SOLID failure: an interface so big nothing can
 * honestly implement all of it yet). When that work starts, add
 * `stopBuildTask()` here AND to EcsDeploymentEngine — TypeScript will refuse
 * to compile until every implementer satisfies the new shape, which is the
 * entire enforcement value of coding to an interface in the first place.
 */
export interface DeploymentEngine {
  /**
   * Starts a build for one deployment and returns as soon as the work has
   * been *handed off* — it does not wait for the build to finish. Progress
   * reporting is the realtime gateway's job (Part 4), not this interface's;
   * mixing "start the work" and "report on the work" into one method would
   * violate Single Responsibility for no benefit.
   */
  launchBuildTask(job: BuildJob): Promise<EngineHandle>;
}

export interface BuildJob {
  deploymentId: string;
  deploymentSlug: string;
  projectId: string;
  repoUrl: string;
  branch: string;
}

export interface EngineHandle {
  /** Provider-specific reference, persisted on Deployment.ecsTaskArn for later lookup. */
  ecsTaskArn: string;
}

/**
 * Fargate implementation. This is the ONLY file in deployments/ that imports
 * an AWS SDK package. Swapping in a `BareMetalEngine` (`docker run` against
 * a local daemon, for local dev without an AWS bill) later is a new class
 * implementing the same interface — deployment.service.ts doesn't change.
 */
export class EcsDeploymentEngine implements DeploymentEngine {
  async launchBuildTask(job: BuildJob): Promise<EngineHandle> {
    const command = new RunTaskCommand({
      cluster: env.ECS_CLUSTER_ARN,
      taskDefinition: env.ECS_TASK_DEFINITION_ARN,
      launchType: 'FARGATE',
      count: 1,
      startedBy: 'api-server',
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'ENABLED',
          subnets: [env.ECS_SUBNET1_ARN, env.ECS_SUBNET2_ARN, env.ECS_SUBNET3_ARN].filter(
            (subnet): subnet is string => Boolean(subnet)
          ),
          securityGroups: env.ECS_SECURITY_GROUP_ARN ? [env.ECS_SECURITY_GROUP_ARN] : [],
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: env.TASK_DEFINITION_IMAGE_NAME,
            environment: [
              { name: 'AWS_ACCESS_KEY_ID', value: env.AWS_ACCESS_KEY_ID ?? '' },
              { name: 'AWS_SECRET_ACCESS_KEY', value: env.AWS_SECRET_ACCESS_KEY ?? '' },
              { name: 'AWS_REGION', value: env.AWS_REGION ?? '' },
              { name: 'REDIS_URL', value: env.REDIS_URL },
              { name: 'GIT_REPOSITORY_URL', value: job.repoUrl },
              { name: 'BRANCH', value: job.branch },
              // Renamed from the prototype's single PROJECT_ID: the build
              // container now needs BOTH identifiers — the deployment ID
              // keys the Redis channel (so logs/status land on the right
              // row), the slug keys the S3 prefix (so it becomes the
              // subdomain) — see Part 6 for why these can no longer be the
              // same value once one project can have many deployments.
              { name: 'DEPLOYMENT_ID', value: job.deploymentId },
              { name: 'DEPLOYMENT_SLUG', value: job.deploymentSlug },
            ],
          },
        ],
      },
    });

    const result = await ecsClient.send(command);
    const taskArn = result.tasks?.[0]?.taskArn;

    if (!taskArn) {
      // result.failures carries ECS's own reason (no capacity, bad subnet,
      // throttled, ...) — surface it instead of a generic message, so a
      // FAILED deployment in the dashboard is actually debuggable.
      const reason = result.failures?.[0]?.reason ?? 'ECS RunTask returned no task ARN';
      throw new Error(`Failed to launch build task: ${reason}`);
    }

    return { ecsTaskArn: taskArn };
  }
}

/**
 * The one place anything in this codebase decides WHICH engine is active.
 * deployment.service.ts imports this constant, never the class — if a
 * factory based on env.DEPLOYMENT_ENVIRONMENT gets added later (cloud vs.
 * bare-metal, per the multi-engine design in your own docs/Ideation_docs),
 * it changes here and nowhere else.
 */
export const deploymentEngine: DeploymentEngine = new EcsDeploymentEngine();
```

### 3.2 `src/deployments/deployment.types.ts`

```typescript
// src/deployments/deployment.types.ts
import { z } from 'zod';
import type { Deployment, DeploymentLog, DeploymentStateTransition } from '../generated/prisma/client';

export const createDeploymentSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  body: z.object({
    // Defaults to the project's own defaultBranch — resolved in the service
    // layer, since the schema has no access to the project row to default
    // against.
    branch: z.string().min(1).max(255).trim().optional(),
  }),
});

export const listDeploymentsQuerySchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
});

export const deploymentIdParamSchema = z.object({
  params: z.object({ deploymentId: z.uuid() }),
});

export const listDeploymentLogsSchema = z.object({
  params: z.object({ deploymentId: z.uuid() }),
  query: z.object({
    // Cursor by sequence number, not offset/limit — logs are an append-only,
    // strictly ordered stream; "give me everything after sequence N" stays
    // correct even while a build is actively writing new lines underneath
    // you. An offset would shift mid-poll.
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  }),
});

export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>['body'];

/** Shape returned to the client — never the AWS ARNs, the S3 prefix, or anything else AWS-shaped. */
export interface PublicDeployment {
  id: string;
  projectId: string;
  slug: string;
  status: Deployment['status'];
  type: Deployment['type'];
  framework: Deployment['framework'];
  branch: string;
  commitHash: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  url: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  errorStep: string | null;
  buildDurationMs: number | null;
  triggeredBy: string;
  queuedAt: Date;
  buildStartedAt: Date | null;
  buildFinishedAt: Date | null;
  deployedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
}

export interface PublicStateTransition {
  id: string;
  fromStatus: DeploymentStateTransition['fromStatus'];
  toStatus: DeploymentStateTransition['toStatus'];
  reason: string | null;
  createdAt: Date;
}

/**
 * DeploymentLog.id is a Postgres BIGSERIAL → Prisma types it as a JS
 * `bigint`. `JSON.stringify({ id: 5n })` throws — `TypeError: Do not know how
 * to serialize a BigInt`. Every log line that crosses the HTTP or socket
 * boundary goes through this DTO (id pre-converted to a string), never the
 * raw Prisma row. This is the single most common production bug with
 * BigInt primary keys in a Node API — worth knowing by name, not just
 * working around once.
 */
export interface PublicLogLine {
  id: string;
  level: DeploymentLog['level'];
  message: string;
  sequence: number;
  source: string | null;
  timestamp: Date;
}

export interface DeploymentDetail extends PublicDeployment {
  stateTransitions: PublicStateTransition[];
}
```

### 3.3 `src/deployments/deployment.service.ts`

The core of the feature. One rule worth stating up front, because it's the backbone of how status
ever changes at all: **`transitionDeploymentStatus` is the only function anywhere in the codebase
allowed to write `Deployment.status`.** Everything else — the controller, the realtime gateway, the
one inline call from `createDeployment` itself — goes through it. That single chokepoint is what
guarantees every status change also gets a `DeploymentStateTransition` row and (when relevant) keeps
`Project.activeDeploymentId` in sync — there's no second code path where someone could update one and
forget the other.

```typescript
// src/deployments/deployment.service.ts
import { generateSlug } from 'random-word-slugs';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { audit, type AuditMeta } from '../lib/audit';
import { ConflictError, NotFoundError } from '../lib/errors';
import { assertProjectOwnership } from '../projects/project.service'; // concrete file, not the barrel — see §0.5
import { deploymentEngine } from './deployment-engine';
import type {
  CreateDeploymentInput,
  DeploymentDetail,
  PublicDeployment,
  PublicLogLine,
} from './deployment.types';
import type { Deployment, DeploymentLog, DeploymentStatus, Prisma } from '../generated/prisma/client';

const SLUG_MAX_ATTEMPTS = 5;

/** Statuses where a build is still in flight — used by the frontend to decide whether to open a socket at all. */
export const ACTIVE_STATUSES: DeploymentStatus[] = ['QUEUED', 'BUILDING', 'UPLOADING', 'STARTING'];

/** Statuses where no further events will ever arrive for this deployment. */
export const TERMINAL_STATUSES: DeploymentStatus[] = ['RUNNING', 'STOPPED', 'FAILED', 'CANCELLED'];

function toPublicDeployment(deployment: Deployment): PublicDeployment {
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    slug: deployment.slug,
    status: deployment.status,
    type: deployment.type,
    framework: deployment.framework,
    branch: deployment.branch,
    commitHash: deployment.commitHash,
    commitMessage: deployment.commitMessage,
    commitAuthor: deployment.commitAuthor,
    url: deployment.url,
    errorMessage: deployment.errorMessage,
    errorCode: deployment.errorCode,
    errorStep: deployment.errorStep,
    buildDurationMs: deployment.buildDurationMs,
    triggeredBy: deployment.triggeredBy,
    queuedAt: deployment.queuedAt,
    buildStartedAt: deployment.buildStartedAt,
    buildFinishedAt: deployment.buildFinishedAt,
    deployedAt: deployment.deployedAt,
    stoppedAt: deployment.stoppedAt,
    createdAt: deployment.createdAt,
  };
}

function toPublicLogLine(log: DeploymentLog): PublicLogLine {
  return {
    id: log.id.toString(), // bigint -> string, see the PublicLogLine comment in deployment.types.ts
    level: log.level,
    message: log.message,
    sequence: log.sequence,
    source: log.source,
    timestamp: log.timestamp,
  };
}

/** Deployment.slug is `@unique @db.VarChar(63)` and becomes the live subdomain — same collision-retry reasoning as project.service.ts. */
async function generateUniqueDeploymentSlug(): Promise<string> {
  for (let attempt = 0; attempt < SLUG_MAX_ATTEMPTS; attempt++) {
    const candidate = generateSlug();
    const existing = await prisma.deployment.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
  }
  throw new ConflictError(
    'Could not generate a unique deployment slug — please try again',
    'SLUG_GENERATION_FAILED'
  );
}

/**
 * Ownership check for a SINGLE deployment, reused by getDeploymentDetail,
 * listDeploymentLogs, AND src/realtime/socket.server.ts (so the socket
 * gateway never re-implements this where-clause itself — see §4.2). Includes
 * stateTransitions because the relation is tiny (a handful of rows per
 * deployment, ever) and every caller except listDeploymentLogs wants it
 * anyway; not worth a second leaner query for that one case.
 */
export async function assertDeploymentOwnership(deploymentId: string, userId: string) {
  const deployment = await prisma.deployment.findFirst({
    where: { id: deploymentId, project: { userId, deletedAt: null } },
    include: { stateTransitions: { orderBy: { createdAt: 'asc' } } },
  });
  if (!deployment) throw new NotFoundError('Deployment not found', 'DEPLOYMENT_NOT_FOUND');
  return deployment;
}

export async function createDeployment(
  projectId: string,
  userId: string,
  input: CreateDeploymentInput,
  meta: AuditMeta
): Promise<PublicDeployment> {
  const project = await assertProjectOwnership(projectId, userId);
  const branch = input.branch ?? project.defaultBranch;
  const slug = await generateUniqueDeploymentSlug();

  // The Deployment row and its first state-transition row are created
  // atomically — there is never a moment a Deployment exists without a
  // QUEUED transition already recorded, which the timeline UI on the
  // deployment detail page relies on existing from the very first render.
  const deployment = await prisma.$transaction(async (tx) => {
    const created = await tx.deployment.create({
      data: {
        projectId,
        slug,
        branch,
        triggeredBy: 'manual',
        status: 'QUEUED',
        s3Prefix: `__outputs/${slug}/`,
      },
    });

    await tx.deploymentStateTransition.create({
      data: {
        deploymentId: created.id,
        fromStatus: null,
        toStatus: 'QUEUED',
        reason: 'Deployment created',
        triggeredBy: 'api',
      },
    });

    return created;
  });

  await audit(userId, 'deployment.create', meta, { resourceType: 'deployment', resourceId: deployment.id });

  // The ECS call is a real network round trip to AWS — deliberately OUTSIDE
  // the transaction above. Holding a Postgres transaction open across an AWS
  // API call would hold row locks (and a connection from your pool) for as
  // long as ECS takes to respond — exactly the kind of thing that takes a
  // small Postgres instance down under any real concurrency.
  try {
    const handle = await deploymentEngine.launchBuildTask({
      deploymentId: deployment.id,
      deploymentSlug: deployment.slug,
      projectId,
      repoUrl: project.repoUrl,
      branch,
    });

    const updated = await prisma.deployment.update({
      where: { id: deployment.id },
      data: { ecsTaskArn: handle.ecsTaskArn },
    });

    return toPublicDeployment(updated);
  } catch (err) {
    // The build container never even started — no log lines and no status
    // report will ever come from build-engine for this deployment, so the
    // API itself is responsible for moving it to a terminal state. This is
    // the ONE place outside transitionDeploymentStatus's own callers in
    // realtime/ that calls it directly.
    const failed = await transitionDeploymentStatus(deployment.id, 'FAILED', {
      reason: 'Failed to launch build task',
      errorCode: 'ENGINE_LAUNCH_FAILED',
      errorMessage: err instanceof Error ? err.message : 'Unknown engine error',
      triggeredBy: 'api',
    });
    return toPublicDeployment(failed ?? deployment);
  }
}

export async function listDeploymentsForProject(
  projectId: string,
  userId: string,
  { cursor, limit }: { cursor?: string; limit: number }
): Promise<{ deployments: PublicDeployment[]; nextCursor: string | null }> {
  await assertProjectOwnership(projectId, userId);

  const rows = await prisma.deployment.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit + 1, // fetch one extra row to know whether a next page exists, without a second COUNT query
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    deployments: page.map(toPublicDeployment),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

export async function getDeploymentDetail(deploymentId: string, userId: string): Promise<DeploymentDetail> {
  const deployment = await assertDeploymentOwnership(deploymentId, userId);

  return {
    ...toPublicDeployment(deployment),
    stateTransitions: deployment.stateTransitions.map((transition) => ({
      id: transition.id,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      reason: transition.reason,
      createdAt: transition.createdAt,
    })),
  };
}

export async function listDeploymentLogs(
  deploymentId: string,
  userId: string,
  { after, limit }: { after: number; limit: number }
): Promise<PublicLogLine[]> {
  // DeploymentLog has no userId column of its own — skipping this ownership
  // check would let any authenticated user read any other user's build
  // output by guessing a deployment UUID (a textbook IDOR). The check has to
  // happen here, on every read, not just at deployment-creation time.
  await assertDeploymentOwnership(deploymentId, userId);

  const logs = await prisma.deploymentLog.findMany({
    where: { deploymentId, sequence: { gt: after } },
    orderBy: { sequence: 'asc' },
    take: limit,
  });

  return logs.map(toPublicLogLine);
}

export interface TransitionOptions {
  reason?: string;
  errorCode?: string;
  errorMessage?: string;
  errorStep?: string;
  url?: string;
  triggeredBy?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * THE state machine. Called by the realtime gateway whenever build-engine
 * reports progress (Part 4), and exactly once directly from
 * createDeployment() above, for the one case where build-engine will never
 * get the chance to report anything itself. No other function writes
 * Deployment.status — see the note at the top of this section for why that
 * invariant matters.
 */
export async function transitionDeploymentStatus(
  deploymentId: string,
  toStatus: DeploymentStatus,
  opts: TransitionOptions = {}
): Promise<Deployment | null> {
  const current = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!current) return null; // e.g. the project was hard-deleted mid-build — nothing left to update

  const now = new Date();
  const timestampPatch: Prisma.DeploymentUpdateInput = {};

  if (toStatus === 'BUILDING' && !current.buildStartedAt) timestampPatch.buildStartedAt = now;

  if ((toStatus === 'UPLOADING' || toStatus === 'STARTING') && !current.buildFinishedAt) {
    timestampPatch.buildFinishedAt = now;
    if (current.buildStartedAt) {
      timestampPatch.buildDurationMs = now.getTime() - current.buildStartedAt.getTime();
    }
  }

  if (toStatus === 'RUNNING' && !current.deployedAt) timestampPatch.deployedAt = now;
  if (toStatus === 'STOPPED' || toStatus === 'FAILED' || toStatus === 'CANCELLED') {
    timestampPatch.stoppedAt = now;
  }

  const updated = await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      status: toStatus,
      url: opts.url,
      errorMessage: opts.errorMessage,
      errorCode: opts.errorCode,
      errorStep: opts.errorStep,
      ...timestampPatch,
    },
  });

  await prisma.deploymentStateTransition.create({
    data: {
      deploymentId,
      fromStatus: current.status,
      toStatus,
      reason: opts.reason,
      triggeredBy: opts.triggeredBy ?? 'build-engine',
      metadata: opts.metadata,
    },
  });

  // Keep Project's denormalized "what's live right now" fields in sync —
  // the entire reason activeDeploymentId/lastDeployedAt exist on Project
  // (per the schema.prisma comment) is so the dashboard home page can show a
  // status badge with zero extra joins.
  if (toStatus === 'RUNNING') {
    await prisma.project.update({
      where: { id: updated.projectId },
      data: { activeDeploymentId: deploymentId, lastDeployedAt: now },
    });
  }

  return updated;
}

/**
 * Allocates the next sequence number for a deployment's log stream and
 * persists the line. Redis INCR is atomic across concurrent writers — the
 * build container's stdout and stderr are read concurrently (see
 * build-engine/script.js in Part 6) — which `SELECT MAX(sequence) + 1` in
 * Postgres is NOT, without taking an explicit row lock on every write.
 */
export async function appendLogLine(
  deploymentId: string,
  line: { level: DeploymentLog['level']; message: string; source?: string }
): Promise<PublicLogLine> {
  const sequenceKey = `deploy:seq:${deploymentId}`;
  const sequence = await redis.incr(sequenceKey);
  await redis.expire(sequenceKey, 60 * 60 * 24 * 7); // 7 days — comfortably outlives any single build

  const log = await prisma.deploymentLog.create({
    data: { deploymentId, level: line.level, message: line.message, source: line.source, sequence },
  });

  return toPublicLogLine(log);
}
```

> **Known, deliberate simplification:** `transitionDeploymentStatus`'s `opts.errorMessage` etc. are
> only ever *set*, never explicitly cleared, on a successful transition after a prior failed attempt.
> In practice every deployment is created fresh (no retry-in-place yet), so this never shows up. If you
> add rollback/retry later, decide explicitly whether a successful `RUNNING` transition should null out
> a stale `errorMessage` from an earlier attempt on the *same* row — right now it would linger
> harmlessly (the dashboard only reads `errorMessage` when `status === 'FAILED'`), but it's the kind of
> thing worth a one-line fix the day it stops being theoretical.

### 3.4 `src/deployments/deployment.controller.ts`

```typescript
// src/deployments/deployment.controller.ts
import type { Request, Response } from 'express';
import * as deploymentService from './deployment.service';
import type { AuditMeta } from '../lib/audit';

function auditMeta(req: Request): AuditMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

export async function createDeploymentHandler(req: Request, res: Response) {
  const deployment = await deploymentService.createDeployment(
    req.params.projectId,
    req.user!.id,
    req.body,
    auditMeta(req)
  );
  res.status(201).json({ deployment });
}

export async function listDeploymentsHandler(req: Request, res: Response) {
  const { cursor, limit } = req.query as unknown as { cursor?: string; limit: number };
  const result = await deploymentService.listDeploymentsForProject(req.params.projectId, req.user!.id, {
    cursor,
    limit,
  });
  res.status(200).json(result);
}

export async function getDeploymentHandler(req: Request, res: Response) {
  const deployment = await deploymentService.getDeploymentDetail(req.params.deploymentId, req.user!.id);
  res.status(200).json({ deployment });
}

export async function getDeploymentLogsHandler(req: Request, res: Response) {
  const { after, limit } = req.query as unknown as { after: number; limit: number };
  const logs = await deploymentService.listDeploymentLogs(req.params.deploymentId, req.user!.id, {
    after,
    limit,
  });
  res.status(200).json({ logs });
}
```

### 3.5 `src/deployments/deployment.routes.ts`

Two routers, because deployment URLs genuinely come in two shapes: ones nested under a project
(`create`, `list`) and ones addressed directly by the deployment's own globally-unique UUID (`detail`,
`logs`). Forcing both into one router mounted at one path would mean either stuttering URLs
(`/projects/:projectId/deployments/:deploymentId` everywhere, even where `projectId` is never read)
or a router that silently ignores part of its own mount path. Two routers, two honest mount points.

```typescript
// src/deployments/deployment.routes.ts
import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import {
  createDeploymentHandler,
  getDeploymentHandler,
  getDeploymentLogsHandler,
  listDeploymentsHandler,
} from './deployment.controller';
import {
  createDeploymentSchema,
  deploymentIdParamSchema,
  listDeploymentLogsSchema,
  listDeploymentsQuerySchema,
} from './deployment.types';

/**
 * Mounted by project.routes.ts at /api/projects/:projectId/deployments.
 * `mergeParams: true` is required for req.params.projectId — captured by
 * the PARENT router's `:projectId` segment — to be visible inside this
 * router's own handlers. Without it, Express only exposes the params this
 * router captures itself.
 */
export const projectDeploymentsRouter = Router({ mergeParams: true });
projectDeploymentsRouter.post('/', validate(createDeploymentSchema), createDeploymentHandler);
projectDeploymentsRouter.get('/', validate(listDeploymentsQuerySchema), listDeploymentsHandler);

/** Mounted directly at /api/deployments — deployment IDs are globally unique UUIDs, no projectId needed in the path. */
export const deploymentsRouter = Router();
deploymentsRouter.get('/:deploymentId', validate(deploymentIdParamSchema), getDeploymentHandler);
deploymentsRouter.get('/:deploymentId/logs', validate(listDeploymentLogsSchema), getDeploymentLogsHandler);
```

### 3.6 `src/deployments/index.ts`

```typescript
// src/deployments/index.ts
export { deploymentsRouter, projectDeploymentsRouter } from './deployment.routes';
export * from './deployment.types';
```

Note what's deliberately **not** re-exported here: `deployment.service.ts`'s
`transitionDeploymentStatus`, `appendLogLine`, and `assertDeploymentOwnership`. `realtime/log-relay.ts`
and `realtime/socket.server.ts` import those straight from `./deployment.service` (the concrete file),
not from this barrel — the barrel's public surface is "what an HTTP route needs," and the realtime
gateway isn't one. This is the same module-boundary discipline as §0.5, applied in the other direction.

### 3.7 Private repositories

`main.sh`'s anonymous `git clone` only ever works for public repos — GitHub returns a 404 for a private
one (deliberately indistinguishable from "doesn't exist," GitHub's own anti-enumeration design) unless
the request carries credentials. Fixing that needs changes in three places: one approved line in
`auth/`, two small additions here in `deployments/`, and a rework of the build container's clone step
(Part 6.5).

**The one-line, approved exception to "auth is untouched."** `auth/github.service.ts`'s OAuth scope is
currently identity-only:

```ts
// src/auth/github.service.ts — BEFORE
scope: 'read:user user:email',
```

That grants zero repository access — even with everything below wired up correctly, GitHub will reject
any private-repo clone with that token, because it genuinely doesn't have permission, not because of a
bug anywhere in this guide. The fix is one string, widening it to include `repo`:

```ts
// src/auth/github.service.ts — AFTER (the only line that changes in this file)
scope: 'read:user user:email repo',
```

Two consequences worth knowing, not hiding: `repo` grants access to **every** repo the user can see,
public and private — there's no narrower scope for "read-only access to just the repos you deploy" in
GitHub's classic OAuth Apps model (only GitHub Apps get that granularity, a bigger migration than this
guide takes on). And anyone who connected GitHub **before** this change has a token issued under the
old, narrower scope — GitHub doesn't retroactively widen it. They self-heal the moment they click
"Continue with GitHub" again: `GET /api/auth/github` → `auth.controller.ts`'s
`githubCallbackHandler` → `authService.loginOrRegisterWithGithub` re-runs the same
`encryptForStorage(githubAccessToken)` write it always does, this time with a token that actually has
`repo` access, overwriting the old one. No new endpoint, no migration script — the existing "Sign in
with GitHub" button doubles as "reconnect with broader access" for free, because
`loginOrRegisterWithGithub` already links by verified email (see the comment on
`fetchPrimaryVerifiedGithubEmail` in `github.service.ts`) rather than requiring a fresh signup.

**`deployments/deployment-engine.ts` — `BuildJob` gets an optional token.** Amend the interface and the
container's `environment` array from §3.1:

```ts
export interface BuildJob {
  deploymentId: string;
  deploymentSlug: string;
  projectId: string;
  repoUrl: string;
  branch: string;
  /**
   * Only set when the project is private. Decrypted just-in-time by
   * deployment.service.ts (next), handed to ECS as a one-shot env var
   * override, and never written to any table — see Part 6.5 for what the
   * build container does with it and why it never touches disk for longer
   * than the clone itself takes.
   */
  gitAccessToken?: string;
}
```

```ts
// inside EcsDeploymentEngine.launchBuildTask's containerOverrides.environment array
{ name: 'DEPLOYMENT_ID', value: job.deploymentId },
{ name: 'DEPLOYMENT_SLUG', value: job.deploymentSlug },
// Conditional, deliberately — a public-repo build is never handed a live
// credential at all, not even one it wouldn't use. Least privilege isn't
// just for IAM policies.
...(job.gitAccessToken ? [{ name: 'GIT_ACCESS_TOKEN', value: job.gitAccessToken }] : []),
```

**`deployments/deployment.service.ts` — fetch and decrypt, only when the project needs it.** Add this
right after `const project = await assertProjectOwnership(projectId, userId);` in `createDeployment`
(§3.3), before the `prisma.$transaction` call:

```ts
import { decryptFromStorage } from '../lib/crypto'; // existing helper, built for User.githubToken — unmodified, just imported here too

// ...inside createDeployment, before the Deployment row is created:
let gitAccessToken: string | undefined;
if (project.isPrivate) {
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { githubToken: true } });
  if (!owner?.githubToken) {
    // Fails BEFORE a Deployment row even exists, let alone before ECS is
    // ever called — an email/password-only user trying to deploy a private
    // repo gets an immediate, actionable 400, not a deployment that queues
    // and then hangs with no explanation.
    throw new BadRequestError(
      'Connect your GitHub account before deploying a private repository',
      'GITHUB_NOT_CONNECTED'
    );
  }
  gitAccessToken = decryptFromStorage(owner.githubToken);
}
```

...and pass it through both calls to `deploymentEngine.launchBuildTask` later in the same function
(the happy path and nothing else needs it — it's never read again after the ECS call returns, and
never assigned to a variable that outlives this function call).

`BadRequestError` is already imported in this file (used by the slug-generation failure path) — no new
import beyond `decryptFromStorage`.

---

## 4. The `realtime/` gateway

This is the bridge between `apps/build-engine` (which only ever talks to Redis — it has no idea the
API server, Postgres, or HTTP exist) and connected dashboard clients. It does two jobs: persist
everything to Postgres (so logs/status survive a page reload and a finished build), and broadcast it
live over Socket.IO (so the dashboard updates without polling).

### 4.0 Why `DEPLOYMENT_ID` specifically, and why structured JSON specifically

Worth being explicit about this, since it's the part that actually requires touching the build-engine
image (Part 6) — everything in this section is downstream of that decision, not an independent one:

- **`DEPLOYMENT_ID`, not just the deployment's slug.** Two identifiers already exist for a deployment:
  `id` (the immutable UUID, the actual primary key, the thing every other table's foreign key points
  at) and `slug` (the human-facing, DNS-safe string that becomes the live subdomain). The realtime
  channel is an **internal, system-facing** address — nothing about it is ever shown to a user — so it
  keys off `id`, the same way `DeploymentLog.deploymentId` and `DeploymentStateTransition.deploymentId`
  do. `slug` stays reserved for the one place it's actually meant to be public: the S3 prefix /
  subdomain. Using the slug for both would work today, but it conflates "what a human sees" with "how
  internal systems address this row" — the moment slugs become editable (a real Vercel feature: you
  can rename a deployment's subdomain after the fact) the channel name would need to migrate
  mid-build. The ID never changes, by definition.
- **Structured JSON (`type`, `level`, `source`), not raw strings.** This is what makes the *status*
  half of this section possible at all — see the "what's actually required" breakdown below — and it's
  also the only way the frontend's `LogPanel` can do anything Vercel's own log viewer does (color by
  severity, tag by source, filter by level) without scraping log text with a regex on every line, which
  breaks the instant a build tool changes its own stdout formatting upstream. One structured event, one
  parse, both consumers (the Postgres write, the Socket.IO broadcast) read the same typed object.

To be precise about which half of this is load-bearing versus which half is "while we're touching this
file anyway": the **status** events (`BUILDING`/`UPLOADING`/`RUNNING`/`FAILED`) are what make the
dashboard's status badges and timeline true at all — without them, `Deployment.status` never leaves
`QUEUED`, full stop, regardless of anything else in this guide. The **log** events being JSON instead
of plain strings is not load-bearing in that same sense — plain strings would still flow end-to-end —
but once a new image is already being shipped to add status reporting, structuring the logs at the
same time costs nothing extra, and `source`/`level` are exactly what the frontend's log viewer (§2.7 of
the frontend guide) renders as Vercel-style tags and icons instead of a flat wall of grey text.

### 4.1 `src/realtime/realtime.types.ts` — the wire contract

There's no shared npm package between `api-server` (TypeScript) and `build-engine` (plain Node, see
Part 6) — they communicate purely through JSON over a Redis channel. This file is the **source of truth** 
for that shape on the TypeScript side; keep `script.js`'s `publishLog`/`publishStatus` calls in
sync with it by hand if either ever changes.

```typescript
// src/realtime/realtime.types.ts
import type { DeploymentLog, DeploymentStatus } from '../generated/prisma/client';

/**
 * Everything published on Redis channel `deployment:{deploymentId}`.
 * build-engine (apps/build-engine/script.js) is the only producer.
 * Two message shapes share one channel, disambiguated by `type` — keeping
 * logs and status on the same channel (rather than two) means one
 * subscriber, one ordering guarantee, one place that can fail.
 */
export type DeploymentEvent = DeploymentLogEvent | DeploymentStatusEvent;

export interface DeploymentLogEvent {
  type: 'log';
  level: DeploymentLog['level'];
  message: string;
  source?: string;
}

export interface DeploymentStatusEvent {
  type: 'status';
  status: DeploymentStatus;
  reason?: string;
  url?: string;
  errorCode?: string;
  errorMessage?: string;
  errorStep?: string;
}

export function isDeploymentEvent(value: unknown): value is DeploymentEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type: unknown }).type;
  return type === 'log' || type === 'status';
}
```

### 4.2 `src/realtime/socket.server.ts`

```typescript
// src/realtime/socket.server.ts
import { Server, type Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/auth.tokens';
import { assertDeploymentOwnership } from '../deployments/deployment.service'; // concrete file — see §3.6
import { env } from '../lib/env';

interface AuthedSocket extends Socket {
  userId?: string;
}

export function roomFor(deploymentId: string): string {
  return `deployment:${deploymentId}`;
}

/**
 * One Socket.IO server for the whole process, created once and handed to
 * log-relay.ts below — the only thing that ever emits through it. Stays on
 * its own port (9002, matching the prototype's apps/frontend
 * `io("http://localhost:9002")` client in app/demo/page.tsx) rather than
 * attaching to the Express app's HTTP server, so a burst of build-log
 * traffic can never compete with API request handling on the same listener.
 */
export function createSocketServer(): Server {
  const io = new Server({ cors: { origin: env.FRONTEND_URL, credentials: true } });

  // Auth happens ONCE, at connection time — not re-checked per event. A
  // socket that never presented a valid access token never even reaches the
  // 'subscribe' handler below; Socket.IO rejects the connection outright.
  io.use((socket: AuthedSocket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('UNAUTHORIZED'));

    try {
      const payload = verifyAccessToken(token);
      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: AuthedSocket) => {
    socket.on('subscribe', async (deploymentId: string) => {
      // The access token only proves WHO is asking — not that they're
      // allowed to watch THIS deployment's logs. Skipping this re-check is
      // the multi-tenant version of an IDOR bug: any logged-in user could
      // otherwise read any other user's build output by guessing a UUID and
      // emitting 'subscribe' with it — exactly the gap the unauthenticated
      // prototype (app/demo/page.tsx's socket.emit('subscribe', ...)) had,
      // harmlessly, before there were multiple users to leak data between.
      try {
        await assertDeploymentOwnership(deploymentId, socket.userId!);
        socket.join(roomFor(deploymentId));
      } catch {
        socket.emit('error', { message: 'Not found or not authorized' });
      }
    });

    socket.on('unsubscribe', (deploymentId: string) => {
      socket.leave(roomFor(deploymentId));
    });
  });

  return io;
}
```

### 4.3 `src/realtime/log-relay.ts`

```typescript
// src/realtime/log-relay.ts
import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { appendLogLine, transitionDeploymentStatus } from '../deployments/deployment.service';
import { env } from '../lib/env';
import { isDeploymentEvent } from './realtime.types';
import { roomFor } from './socket.server';

const CHANNEL_PATTERN = 'deployment:*';

/**
 * Bridges build-engine's Redis pub/sub messages to (a) Postgres, so logs and
 * status survive a page reload or a finished build, and (b) every connected
 * dashboard client watching that deployment, via Socket.IO. This is the
 * ONLY thing in api-server that calls
 * deploymentService.{appendLogLine,transitionDeploymentStatus} on behalf of
 * something outside an HTTP request — keeping that in one file is what
 * makes "where do status updates actually come from?" a one-file answer.
 */
export async function startLogRelay(io: Server): Promise<void> {
  // A DEDICATED connection. Once an ioredis client calls (p)subscribe it can
  // no longer run ordinary commands (appendLogLine's INCR, for instance) —
  // this can never be the same client lib/redis.ts hands out for everyday
  // use.
  const subscriber = new Redis(env.REDIS_URL);
  await subscriber.psubscribe(CHANNEL_PATTERN);

  subscriber.on('pmessage', async (_pattern: string, channel: string, raw: string) => {
    const deploymentId = channel.slice('deployment:'.length);

    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      console.error('[LOG_RELAY] Non-JSON message on', channel, raw);
      return;
    }

    if (!isDeploymentEvent(event)) {
      console.error('[LOG_RELAY] Unrecognized event shape on', channel, event);
      return;
    }

    try {
      if (event.type === 'log') {
        const log = await appendLogLine(deploymentId, event);
        io.to(roomFor(deploymentId)).emit('log', log);
      } else {
        const updated = await transitionDeploymentStatus(deploymentId, event.status, {
          reason: event.reason,
          url: event.url,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          errorStep: event.errorStep,
        });
        if (updated) {
          io.to(roomFor(deploymentId)).emit('status', { status: updated.status, url: updated.url });
        }
      }
    } catch (err) {
      // A malformed or late-arriving event must never crash the relay —
      // every OTHER in-flight deployment's logs depend on this exact same
      // subscriber connection staying alive.
      console.error('[LOG_RELAY] Failed to process event for deployment', deploymentId, err);
    }
  });
}
```

### 4.4 `src/realtime/index.ts`

```typescript
// src/realtime/index.ts
import { startLogRelay } from './log-relay';
import { createSocketServer } from './socket.server';

const SOCKET_PORT = 9002; // unchanged from the prototype — apps/frontend's socket client already points here

/** Called once from src/index.ts at process boot. */
export async function startRealtimeGateway(): Promise<void> {
  const io = createSocketServer();
  io.listen(SOCKET_PORT);
  console.log(`Realtime gateway listening on port ${SOCKET_PORT}`);

  await startLogRelay(io);
  console.log(`Subscribed to deployment:* for log + status relay`);
}
```

---

## 5. Editing `app.ts` and `index.ts`

### 5.1 `src/app.ts` — full file

The old inline `/api/deploy` handler (raw `ECSClient`, no DB row, no auth) is removed entirely — it's
superseded by `POST /api/projects/:projectId/deployments`. The `ECSClient` construction and
`RunTaskCommand` import move to `deployment-engine.ts` (Part 3.1). Everything in `auth/` is untouched.

```typescript
// src/app.ts
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authRouter, requireAuth } from './auth';
import { deploymentsRouter } from './deployments';
import { errorHandlerMiddleware } from './middleware/error-handler.middleware';
import { projectsRouter } from './projects';
import { env } from './lib/env';

export const app = express();

// Render sits exactly one reverse-proxy hop in front of this app. Trusting
// only that one hop (not `true`, which trusts the whole X-Forwarded-For
// chain) is what lets req.ip resolve to the real visitor — and is what
// express-rate-limit needs to key the abuse-prone auth routes correctly.
app.set('trust proxy', true); // Trust the first proxy (e.g., load balancer) for correct client IP and secure cookie handling

// CORS must allow exactly ONE known origin (never '*') AND credentials: true,
// or the browser silently refuses to send/receive the refresh cookie at all.
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRouter);

// Everything under /api/projects and /api/deployments requires a logged-in
// user — unlike /api/auth (where /register, /login, /github are
// intentionally public), nothing here ever is. requireAuth is applied ONCE,
// at the mount point, rather than route-by-route inside projects/deployments
// routers, since there's no per-route exception to handle.
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/deployments', requireAuth, deploymentsRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// MUST be the LAST app.use() call — Express only treats a 4-argument
// function as an error handler, and only catches errors from middleware/
// routes registered before it.
app.use(errorHandlerMiddleware);
```

### 5.2 `src/index.ts` — full file

Previously this file constructed its own Socket.IO server and Redis subscriber inline. Both move into
`realtime/`, so this file goes back to doing exactly one thing: boot the process.

```typescript
// src/index.ts
import { app } from './app';
import { env } from './lib/env';
import { startRealtimeGateway } from './realtime';

startRealtimeGateway();

app.listen(env.PORT, () => {
  console.log(`API server is running on port ${env.PORT}`);
});
```

### 5.3 Cleanup note: `apps/frontend/app/demo/page.tsx`

This page predates the dashboard entirely — it posts to `http://localhost:3000/project` (note: port
3000, the *frontend's own* port, not the API server's 8000; and the path `/project`, which no longer
exists in `app.ts` even in the old version, which used `/api/deploy`). It was already disconnected from
the real API before this guide. It's safe to delete once the new `/dashboard` flow is live — nothing
in Part 7 (frontend) depends on it — but it isn't touched by anything above, so deleting it is your
call, not a required step.

---

## 6. Updating `apps/build-engine`

The build container is the only producer on the `deployment:*` Redis channel. It needs four changes:
publish **structured** events instead of raw strings (so `realtime.types.ts`'s contract has something
to parse), report **status transitions** explicitly (BUILDING at start, UPLOADING before the S3 sync,
RUNNING with the final URL, FAILED on any error) instead of never reporting status at all, key
everything by **deployment ID / deployment slug** instead of the old single `PROJECT_ID`, and — new as
of §3.7 — authenticate the clone for private repos without ever letting the token touch a log line or
outlive the clone itself.

That last one comes with a structural change worth calling out before the code: in the original
prototype, `main.sh` ran `git clone` as a separate shell step **before `script.js` ever started**. That
meant a clone failure — wrong branch, repo renamed, or (the whole reason this section exists) a private
repo with no credentials — killed the container before `script.js`'s `init()` got the chance to run, so
**nothing ever called `publishStatus('FAILED', ...)`**. The deployment would sit at whatever status it
was last in (usually `BUILDING`, since that's the first thing this guide has it announce) forever, with
no error message, because the one thing capable of reporting "this failed" never got to execute. The
fix: move the clone *into* `script.js`'s existing `try/catch`, so a failed clone is reported exactly the
same way a failed `npm run build` already is. `main.sh` shrinks to a one-line shim.

### 6.1 `apps/build-engine/script.js` — full file

```javascript
// apps/build-engine/script.js
const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const mime = require('mime-types')
const Redis = require('ioredis')

const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
})

const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID
const DEPLOYMENT_SLUG = process.env.DEPLOYMENT_SLUG
const GIT_REPOSITORY_URL = process.env.GIT_REPOSITORY_URL
const BRANCH = process.env.BRANCH || 'main'
const S3_BUCKET = process.env.S3_BUCKET || 'dreamer-outputs'
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'singularitydev.xyz'
const NETRC_PATH = path.join(os.homedir(), '.netrc')

// Same channel carries both log lines and status events — api-server's
// src/realtime/log-relay.ts tells them apart by `type`. Keep this contract
// in sync BY HAND with src/realtime/realtime.types.ts on the API server —
// there's no shared package between this app (plain Node) and that one
// (TypeScript) to enforce it for you.
const CHANNEL = `deployment:${DEPLOYMENT_ID}`

function publishLog(message, level = 'INFO', source = 'build') {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'log', level, message, source }))
}

function publishStatus(status, extra = {}) {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'status', status, ...extra }))
}

/**
 * For private repos, EcsDeploymentEngine (api-server's deployment-engine.ts)
 * hands this container a GIT_ACCESS_TOKEN env var — the project owner's
 * decrypted GitHub token, scoped for exactly this one task run. We write it
 * to ~/.netrc rather than embedding it in the clone URL: if git ever echoes
 * the URL it's operating on (it does, on several error paths), a
 * netrc-based credential means that echo is always the plain
 * https://github.com/... URL, never one with a token baked into it.
 */
function writeNetrcIfNeeded() {
    if (!process.env.GIT_ACCESS_TOKEN) return
    fs.writeFileSync(
        NETRC_PATH,
        `machine github.com\nlogin x-access-token\npassword ${process.env.GIT_ACCESS_TOKEN}\n`,
        { mode: 0o600 }
    )
}

/**
 * Best-effort, fire-and-forget cleanup — called right after a successful
 * clone AND again in `finally`, so the token can't outlive the one git
 * operation that needed it. The first call matters more than it looks:
 * without it, the token would still be sitting on disk for the ENTIRE
 * `npm install && npm run build` that follows — meaning any compromised or
 * malicious package's postinstall script could read a live GitHub token
 * straight off the filesystem. Scrubbing it before npm ever runs closes
 * that window completely, not just eventually.
 */
function scrubNetrc() {
    fs.rm(NETRC_PATH, { force: true }, () => {})
}

function runClone(targetPath) {
    return new Promise((resolve, reject) => {
        const p = exec(`git clone --branch "${BRANCH}" --single-branch "${GIT_REPOSITORY_URL}" "${targetPath}"`)

        // Safe to publish verbatim — git only ever sees the plain repo URL
        // (credentials come from ~/.netrc, never the command line or the
        // URL string), so nothing it prints to stderr can contain the token.
        p.stderr.on('data', (data) => publishLog(data.toString(), 'WARN', 'platform'))

        p.on('close', (code) => {
            if (code === 0) {
                resolve()
            } else {
                // GitHub returns the same 404 for "doesn't exist" and "you
                // don't have access" — deliberately, to avoid leaking which
                // private repos exist. This message can't tell those apart
                // either; the dashboard surfaces it as a hint to check the
                // GitHub connection rather than asserting the repo is missing.
                reject(new Error(
                    `git clone exited with code ${code} — check the repository URL and branch, and (for private repos) that your GitHub connection still has access`
                ))
            }
        })
    })
}

// Helper function to run the build sequentially
function runBuildCommand(dirPath) {
    return new Promise((resolve, reject) => {
        const p = exec(`cd ${dirPath} && npm install && npm run build`)

        p.stdout.on('data', function (data) {
            console.log(data.toString())
            publishLog(data.toString())
        })

        // stderr is mostly npm warning chatter and build-tool progress
        // output, not necessarily a fatal error — WARN, not ERROR. The
        // build's actual pass/fail signal is the exit code in p.on('close'),
        // not which stream a given line happened to print to.
        p.stderr.on('data', function (data) {
            console.error(data.toString())
            publishLog(data.toString(), 'WARN')
        })

        p.on('close', function (code) {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`Build process exited with code ${code}`))
            }
        })
    })
}

async function init() {
    console.log('Executing script.js')
    publishLog('Build started', 'SYSTEM')
    publishStatus('BUILDING')

    const outDirPath = path.join(__dirname, 'output')

    try {
        // 0. Clone — now INSIDE this try/catch, unlike the original
        // prototype where main.sh ran it before this process even started
        // (see the note above Part 6.1 for why that made clone failures
        // invisible to the dashboard).
        writeNetrcIfNeeded()
        publishLog(`Cloning ${GIT_REPOSITORY_URL} (branch: ${BRANCH})`, 'SYSTEM', 'platform')
        await runClone(outDirPath)
        scrubNetrc() // before npm touches a single dependency — see the comment on scrubNetrc()

        // 1. Wait for the build to completely finish
        await runBuildCommand(outDirPath)

        console.log('Build Complete')
        publishLog('Build complete', 'SYSTEM')

        const distFolderPath = path.join(__dirname, 'output', 'dist')

        // Safety check to ensure the framework actually built a 'dist' folder
        if (!fs.existsSync(distFolderPath)) {
            throw new Error(`Build finished but expected output directory 'dist' was not found at ${distFolderPath}`)
        }

        publishStatus('UPLOADING')
        publishLog('Starting upload to S3', 'SYSTEM', 'platform')

        const distFolderContents = fs.readdirSync(distFolderPath, { recursive: true })
        let uploadedCount = 0

        for (const file of distFolderContents) {
            const filePath = path.join(distFolderPath, file)
            if (fs.lstatSync(filePath).isDirectory()) continue;

            console.log('uploading', filePath)
            publishLog(`uploading ${file}`, 'INFO', 'platform')

            // __outputs/{DEPLOYMENT_SLUG}/... — keyed by the DEPLOYMENT's
            // slug now, not the project's. This is what Deployment.s3Prefix
            // in schema.prisma documents ("__outputs/{slug}/") and it's why
            // apps/reverse-proxy needs NO changes at all: it already proxies
            // subdomain -> __outputs/{subdomain}, and the subdomain a user
            // visits IS this deployment's slug.
            const command = new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: `__outputs/${DEPLOYMENT_SLUG}/${file}`,
                Body: fs.createReadStream(filePath),
                ContentType: mime.lookup(filePath) || 'application/octet-stream'
            })

            await s3Client.send(command)
            uploadedCount++
            publishLog(`uploaded ${file}`, 'INFO', 'platform')
        }

        const url = `https://${DEPLOYMENT_SLUG}.${BASE_DOMAIN}`
        publishLog(`Done — ${uploadedCount} files uploaded`, 'SYSTEM')
        publishStatus('RUNNING', { url })
        console.log('Done...')
    } catch (error) {
        console.error('Fatal execution error:', error.message)
        publishLog(`Fatal error: ${error.message}`, 'ERROR', 'platform')
        publishStatus('FAILED', { errorMessage: error.message, errorCode: 'BUILD_FAILED', errorStep: 'build' })
        process.exitCode = 1
    } finally {
        // Guarantees cleanup even if the clone itself is what threw — the
        // success-path call above is the one that matters for the
        // npm-install threat model, but this one matters for "the process
        // is about to exit no matter what, leave nothing behind."
        scrubNetrc()
        // publisher.publish() is fire-and-forget over an already-open
        // connection — give the last message a moment to actually flush
        // over the socket before the process (and the whole Fargate task)
        // exits.
        setTimeout(() => publisher.quit(), 250)
    }
}

init()
```

> One field deliberately left out to keep this example focused: `Deployment.uploadedFileCount` exists
> on the schema and would be a one-line addition — pass `{ url, uploadedFileCount }` into the final
> `publishStatus('RUNNING', ...)` call, and add `uploadedFileCount` to `TransitionOptions` and the
> `data: {...}` patch in `transitionDeploymentStatus`. Same shape as everything else here; left as a
> natural next step rather than padding this guide with a metric that doesn't change how anything
> behaves yet.

### 6.2 `apps/build-engine/main.sh` — full file

Reduced to a one-line shim, now that `script.js` owns the entire pipeline — clone included. Kept as a
separate file at all (rather than inlining `node script.js` straight into the Dockerfile's `CMD`)
purely so the Dockerfile itself doesn't need to change.

```bash
#!/bin/bash
exec node script.js
```

### 6.3 `apps/build-engine/.env.example` — full file

For reference when running the build container outside ECS (e.g. `docker run -e ...` for local
testing) — in real deployments every one of these except `S3_BUCKET`/`BASE_DOMAIN` is injected by
`EcsDeploymentEngine`'s `containerOverrides`, not hand-edited.

```
REDIS_URL=redis://localhost:6379

AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key
S3_BUCKET=dreamer-outputs
BASE_DOMAIN=singularitydev.xyz

# Injected by api-server's EcsDeploymentEngine (src/deployments/deployment-engine.ts)
# as ECS task container overrides for a real run — only set these by hand
# when testing the build container standalone, outside ECS.
DEPLOYMENT_ID=
DEPLOYMENT_SLUG=
GIT_REPOSITORY_URL=
BRANCH=main

# Only present for a private-repo deployment — see §3.7 on the backend side.
# Never set this by hand against your own real GitHub token for local
# testing unless you're prepared to revoke it afterwards; use a disposable
# fine-grained PAT scoped to one test repo instead.
GIT_ACCESS_TOKEN=
```

### 6.4 Why `apps/reverse-proxy` needs zero changes

Worth stating explicitly, since it's easy to assume otherwise: `apps/reverse-proxy/index.js` extracts
the subdomain from the request `Host` header and proxies straight to
`{BASE_PATH}/__outputs/{subdomain}`. Before this guide, `{subdomain}` was the project's slug, because
one project had (at most) one meaningful deployment. After this guide, `{subdomain}` is a
*deployment's* slug — and that's exactly what `script.js` now uploads under
(`__outputs/{DEPLOYMENT_SLUG}/...`). The reverse proxy's logic — "take the subdomain, look in
`__outputs/{subdomain}`" — was already deployment-slug-shaped; the prototype just happened to only ever
have one deployment per project, so the distinction never surfaced. No file in `reverse-proxy/` changes.

### 6.5 Shipping this: rebuilding the image, pushing to ECR, and the one gotcha that bites people

This is the part of the question that matters operationally, separate from whether the code change
itself is justified: **a `script.js`/`main.sh` edit does nothing in production until a new image is
built and pushed.** `EcsDeploymentEngine.launchBuildTask` (§3.1) only ever passes environment-variable
*overrides* into `RunTaskCommand` — it has no way to change what code is actually running inside the
container. That code is baked into the image at build time. The deploy sequence is:

```bash
# from apps/build-engine/
docker build -t dreamer-build-engine .
docker tag dreamer-build-engine:latest <account-id>.dkr.ecr.<region>.amazonaws.com/dreamer-build-engine:latest

aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com

docker push <account-id>.dkr.ecr.<region>.amazonaws.com/dreamer-build-engine:latest
```

The gotcha: **whether this is enough depends entirely on how your task definition references the
image.**

- If the task definition's container image is `...:latest` (a mutable tag), the push above is
  sufficient on its own — but only for **tasks launched after the push**. ECS does not re-pull or
  restart anything already running; any deployment that was mid-build at push time keeps running the
  *old* image until it finishes. There is no task-definition revision bump required, which is
  convenient, but it also means `:latest` can silently drift — two builds running concurrently across
  a deploy could be on two different versions of `script.js` with no record of which ran which, which
  is a real debugging headache the first time a build behaves unexpectedly and you can't immediately
  tell if it was even running your latest code.
- If the task definition pins an **image digest** (`...@sha256:...`) — the safer, reproducible option,
  and the one worth moving to if you're not already there — pushing alone does nothing: you must
  register a new task definition revision with the new digest
  (`aws ecs register-task-definition ...`) and update `ECS_TASK_DEFINITION_ARN` in the API server's
  `.env` to point at the new revision before `EcsDeploymentEngine` will ever launch a task using it.

Either way, this is the actual cost of the build-engine changes in this guide, stated plainly: one
image rebuild/push, and — if you're pinning digests — one task-definition revision bump. Nothing here
needs a CI pipeline to get *started*, but if you're doing this more than a couple of times, it's worth
scripting the four commands above into one `npm run` target rather than running them by hand each time.

---

## 7. The complete API surface

```
PROJECTS                                                    (all require Authorization: Bearer <token>)
POST    /api/projects                          Create a project
GET     /api/projects                          List the user's projects + latest deployment each
GET     /api/projects/:projectId               Project detail
PATCH   /api/projects/:projectId               Update name/description/defaultBranch
DELETE  /api/projects/:projectId               Soft delete

DEPLOYMENTS
POST    /api/projects/:projectId/deployments   Trigger a deployment → ECS RunTask
GET     /api/projects/:projectId/deployments   Paginated deployment history (?cursor=&limit=)
GET     /api/deployments/:deploymentId         Deployment detail + state transitions
GET     /api/deployments/:deploymentId/logs    Paginated log history (?after=&limit=)

REALTIME (Socket.IO, port 9002 — separate from the HTTP API)
connect  { auth: { token } }                   Rejected with 'UNAUTHORIZED' if missing/invalid
emit     'subscribe'   deploymentId            Joins room deployment:{id}, IF the user owns it
emit     'unsubscribe' deploymentId            Leaves the room
on       'log'          PublicLogLine          One new log line
on       'status'       { status, url }        A status transition just happened
```

## 8. Testing the full flow with `curl`

Assuming the API server and the `frontend`'s dev auth flow have already gotten you a real
`accessToken` (copy it from the Network tab after logging in, or from `POST /api/auth/login`'s
response directly):

```bash
TOKEN="<your accessToken>"
API=http://localhost:8000

# 1. Create a project — slug is derived from the name (see §2.2), not random
curl -s -X POST $API/api/projects \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"My Vite App","repoUrl":"https://github.com/someone/some-vite-app"}'
# → 201 { "project": { "id": "...", "slug": "my-vite-app", "repoFullName": "someone/some-vite-app", ... } }

PROJECT_ID="<id from above>"

# 1b. Create a SECOND project with the same name — confirms the collision
#     fallback actually fires
curl -s -X POST $API/api/projects \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"My Vite App","repoUrl":"https://github.com/someone/some-other-vite-app"}'
# → 201 { "project": { "slug": "my-vite-app-a1b2c3", ... } } — same base, random suffix appended

# 2. Trigger a deployment
curl -s -X POST $API/api/projects/$PROJECT_ID/deployments \
  -H "Authorization: Bearer $TOKEN"
# → 201 { "deployment": { "id": "...", "slug": "...", "status": "QUEUED", ... } }

DEPLOYMENT_ID="<id from above>"

# 3. Poll detail — status should move QUEUED -> BUILDING -> UPLOADING -> RUNNING
#    as build-engine reports progress through the realtime gateway
curl -s $API/api/deployments/$DEPLOYMENT_ID -H "Authorization: Bearer $TOKEN"

# 4. Read back persisted logs (works even after the build finishes — this is
#    the DB-durability half of the dual mechanism, independent of the socket)
curl -s "$API/api/deployments/$DEPLOYMENT_ID/logs?after=0&limit=100" \
  -H "Authorization: Bearer $TOKEN"

# 5. Dashboard home query
curl -s $API/api/projects -H "Authorization: Bearer $TOKEN"

# 6. Private repo, BEFORE connecting GitHub — confirms the fast, clear 400
#    from §3.7 rather than a deployment that queues and silently hangs
curl -s -X POST $API/api/projects \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Secret App","repoUrl":"https://github.com/someone/private-repo","isPrivate":true}'
PRIVATE_PROJECT_ID="<id from above>"
curl -s -X POST $API/api/projects/$PRIVATE_PROJECT_ID/deployments -H "Authorization: Bearer $TOKEN"
# → 400 { "error": "Connect your GitHub account before deploying a private repository", "code": "GITHUB_NOT_CONNECTED" }
# Now connect GitHub via the frontend (or hit /api/auth/github directly in a
# browser, not curl — it's a redirect-based OAuth flow) and repeat: this time
# it should queue normally and the build container's clone should succeed.
```

Expected validation-error response for a bad project creation payload (`{"name":"","repoUrl":"not-a-url"}`)
— every field's error in one pass, same aggregation behavior `validate.middleware.ts` already gives
`/auth/register`:

```
HTTP/1.1 400 Bad Request
{"error":"body.name: Too small: expected string to have >=1 characters; body.repoUrl: Invalid URL","code":"VALIDATION_ERROR"}
```

---

## 9. SOLID / LLD principles, mapped to what you just built

You asked to actually learn this, not just paste code, so here's where each principle shows up
concretely, not abstractly:

**Single Responsibility.** `project.service.ts` only ever talks to Postgres for `Project` rows.
`deployment-engine.ts` only ever talks to AWS. `log-relay.ts` only ever moves Redis events into
Postgres + Socket.IO. None of these files would need to change for a reason unrelated to its own name
— that's the actual test for SRP, not "one function per file."

**Open/Closed.** `DeploymentEngine` is closed for modification (deployment.service.ts never changes
when you add a new way to run builds) but open for extension (a `BareMetalEngine` class implementing
the same interface is a pure addition, zero edits to existing call sites).

**Liskov Substitution.** Any future `DeploymentEngine` implementation must honestly satisfy
"`launchBuildTask` returns once the work has been handed off, not once it's done" — swapping
`EcsDeploymentEngine` for a hypothetical synchronous `BareMetalEngine` that blocks until the build
finishes would violate this contract, even though it "implements the interface." The interface's
*behavioral* promise, not just its method signature, is what callers are allowed to rely on.

**Interface Segregation.** `DeploymentEngine` has exactly one method because that's all
`deployment.service.ts` needs. It does NOT also expose `sleepDeployment`/`wakeDeployment` "for later" —
an interface with methods no current implementer can honestly fulfill forces every future implementer
to either fake them or throw `NotImplementedError`, which is worse than not having them yet.

**Dependency Inversion.** `deployment.service.ts` imports `DeploymentEngine` (an interface) and the
`deploymentEngine` constant (a pre-selected instance) — never `@aws-sdk/client-ecs` directly. The
*module dependency arrow* points from the concrete AWS adapter toward the abstraction, same direction
as the business logic's dependency on it. That inversion is what makes the AWS SDK swappable and,
just as importantly, makes `deployment.service.ts` unit-testable with a fake engine and zero AWS
credentials.

**A non-SOLID-acronym LLD point that matters just as much:** the single-writer rule on
`Deployment.status` (§3.3) and the barrel-vs-concrete-file import discipline (§0.5, §3.6) aren't named
principles with a letter — but they're the difference between a codebase where "who changes this and
when" has one obvious answer, and one where it doesn't. That property degrades faster than any single
class design choice as a codebase grows; it's worth protecting more deliberately than the acronym
suggests.

---

## 10. What's deliberately out of scope here (and where it picks up)

These are real, schema-ready features explicitly **not** built in this guide, so the scope stayed
honest to "the dashboard" rather than ballooning into the entire platform roadmap:

- **Environment variables CRUD** (`EnvVariable` model already exists) — a `projects/:projectId/env`
  sub-feature, same shape as `deployments/`, with AES-256-GCM encryption reusing
  `src/lib/crypto.ts`'s `encryptForStorage`/`decryptFromStorage` (already built for `User.githubToken`
  — the exact same functions work for env var values unchanged).
- **Custom domains** (`CustomDomain` model already exists) — DNS TXT verification + SSL status polling.
- **GitHub webhook auto-deploy** (`WebhookDelivery` model already exists) — HMAC-verified push handler
  that calls `deploymentService.createDeployment` exactly the way the dashboard's "Deploy" button does;
  your `dreamer_db_dashboard_continued.md` planning doc already has a worked example of the handler
  shape.
- **Framework auto-detection** — `Deployment.framework`/`Deployment.type` stay `null` until
  `build-engine` actually inspects the cloned repo (`package.json` scripts, presence of
  `next.config.js`, etc.) — not faked here with a dropdown that doesn't influence the actual build.
- **Stop/Sleep/Wake (scale-to-zero)** — `DeploymentEngine` was shaped in §3.1 specifically so this
  slots in as new interface methods later without touching `deployment.service.ts`'s existing code.

None of these required a single line of the schema, the auth system, or anything above to change to
become buildable — that's what "designed for upgradability" concretely cashed out to.
