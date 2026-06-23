# Dreamer Dashboard — Frontend (Vercel-style Project & Deployment UI), End-to-End

The frontend half of the dashboard: a project grid, an "Import Project" flow, a project overview page,
and a deployment detail page with live streaming logs — built against your real
`apps/frontend` as it stands (the real `AuthProvider`/`apiFetch`/`RequireAuth` you already have, the
real Tailwind v4 + `globals.css` tokens, the real component conventions from `login/page.tsx` and
`dashboard/page.tsx`). Zero new dependencies — `socket.io-client` and `lucide-react` are already in
`package.json`.

Pairs with `DASHBOARD_BACKEND_IMPL.md` — every type and endpoint referenced here is defined there.

---

## 0. The architecture, and why

### 0.1 Why every page below is a Client Component (no exception)

Planning notes for this kind of dashboard often reach for Next.js Server Components — `await
getCurrentUser()` in a server `page.tsx`, no loading spinner, data ready on first paint. That pattern
is wrong for **this specific app**, for a reason that's already written down in your own
`require-auth.tsx`:

> *"It's a CLIENT-side check on purpose — see Section 0 for why a proxy.ts cookie check would not
> actually work for this architecture (the refresh cookie is scoped to the API's own host, not the
> frontend's)."*

Your access token lives in **JS memory only** (`lib/api-client.ts`'s module-level `accessToken`
variable) — by design, specifically so an XSS payload can't read it out of `localStorage`. A Server
Component runs on the Next.js server, which has no access to that in-memory value and no way to ask
for it (the refresh *cookie* is `httpOnly` and scoped to the API server's own domain, not the
frontend's — your frontend's Next.js server can't read it either). There is no server-side code path
in this app that can produce a valid `Authorization: Bearer` header. Every page below is `"use client"`
and fetches through `apiFetch`, exactly like the existing `dashboard/page.tsx` already does.

### 0.2 Route structure — and one deliberate deviation from the "obvious" plan

```
app/
├── dashboard/
│   ├── layout.tsx                                    # NEW — RequireAuth + DashboardShell, once
│   ├── page.tsx                                       # REWRITTEN — project grid (was an account-info demo)
│   ├── new/
│   │   └── page.tsx                                   # NEW — Import Git Repository
│   └── projects/
│       └── [projectId]/
│           ├── page.tsx                                # NEW — project overview
│           └── deployments/
│               └── [deploymentId]/
│                   └── page.tsx                        # NEW — live build logs + status timeline
```

Nesting projects/deployments **under** `/dashboard` (rather than `/projects/...` at the root, which is
what generic planning docs for this kind of app tend to sketch) is the one intentional change from "the
obvious layout." The payoff: a single `app/dashboard/layout.tsx` wraps the auth guard and the shared
topbar shell for the *entire* section, in one place — instead of every page repeating the
`<RequireAuth><Shell>...</Shell></RequireAuth>` boilerplate the current `dashboard/page.tsx` does
ad hoc. It also costs nothing: nothing currently links to a bare `/projects/...` path, and
`login/page.tsx`'s `redirectTo = searchParams.get("redirect") || "/dashboard"` keeps working
unchanged.

### 0.3 Data fetching pattern

No server data fetching, no React Query, no SWR — matching what's already here. Every page:
`useState` + `useEffect` + `apiFetch`, exactly like `dashboard/page.tsx`'s existing `/api/auth/me`
call. A thin `lib/dashboard-api.ts` wraps the fetch + JSON-parse + error boilerplate once, the same way
`lib/auth.ts` already does for the auth endpoints.

### 0.4 Realtime: one hook, used by exactly one page

Only the deployment detail page needs a live socket — everywhere else (the project grid, the project
overview's deployment list) is fine re-fetching on demand or on a page revisit. `lib/use-deployment-socket.ts`
is a single-purpose hook: connect, authenticate with the in-memory access token, join one room, hand
events back via callbacks, clean up on unmount. It deliberately knows nothing about React state
management beyond that — the deployment detail page owns merging "logs fetched over REST on load" with
"logs that arrived live over the socket since," because that merge is a page-specific concern, not a
hook-generic one.

---

## 1. Shared `lib/` files

### 1.1 `lib/dashboard-types.ts`

Mirrors the backend DTOs by hand — same convention `lib/auth.ts` already uses for `AuthUser`
("Mirrors `PublicUser` from the API's `src/auth/auth.types.ts` — keep these in sync"). No codegen, no
shared package between the two apps; if a backend DTO field changes, this file needs a matching edit.

```typescript
// lib/dashboard-types.ts

// Mirrors src/generated/prisma/enums.ts's DeploymentStatus on the API —
// keep in sync if the schema's enum ever changes.
export type DeploymentStatus =
  | "QUEUED"
  | "BUILDING"
  | "UPLOADING"
  | "STARTING"
  | "RUNNING"
  | "SLEEPING"
  | "WAKING"
  | "STOPPED"
  | "FAILED"
  | "CANCELLED"
  | "ERROR";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG" | "SYSTEM";

// Mirrors PublicProject from the API's src/projects/project.types.ts.
export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  repoUrl: string;
  repoFullName: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  activeDeploymentId: string | null;
  lastDeployedAt: string | null; // dates cross JSON as ISO strings, not Date instances
  createdAt: string;
}

// Mirrors LatestDeploymentSummary from project.types.ts.
export interface LatestDeploymentSummary {
  id: string;
  slug: string;
  status: DeploymentStatus;
  url: string | null;
  branch: string;
  commitMessage: string | null;
  createdAt: string;
}

// Mirrors ProjectWithLatestDeployment from project.types.ts.
export interface ProjectWithLatestDeployment extends Project {
  deploymentCount: number;
  latestDeployment: LatestDeploymentSummary | null;
}

// Mirrors PublicDeployment from the API's src/deployments/deployment.types.ts.
export interface Deployment {
  id: string;
  projectId: string;
  slug: string;
  status: DeploymentStatus;
  type: "STATIC" | "DYNAMIC" | null;
  framework: string | null;
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
  queuedAt: string;
  buildStartedAt: string | null;
  buildFinishedAt: string | null;
  deployedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
}

// Mirrors PublicStateTransition.
export interface StateTransition {
  id: string;
  fromStatus: DeploymentStatus | null;
  toStatus: DeploymentStatus;
  reason: string | null;
  createdAt: string;
}

export interface DeploymentDetail extends Deployment {
  stateTransitions: StateTransition[];
}

// Mirrors PublicLogLine. id is a string here too — the API already
// converts the Postgres bigint before it ever reaches JSON; see the comment
// on PublicLogLine in the backend's deployment.types.ts for why that
// conversion has to happen server-side, not here.
export interface LogLine {
  id: string;
  level: LogLevel;
  message: string;
  sequence: number;
  source: string | null;
  timestamp: string;
}

export const ACTIVE_STATUSES: DeploymentStatus[] = ["QUEUED", "BUILDING", "UPLOADING", "STARTING"];
export const TERMINAL_STATUSES: DeploymentStatus[] = ["RUNNING", "STOPPED", "FAILED", "CANCELLED"];
```

### 1.2 `lib/dashboard-api.ts`

Same shape as `lib/auth.ts`'s `parseAuthResponse` — one shared error-unwrapping helper, then one
thin function per endpoint, all going through the existing `apiFetch` (which already handles the
Bearer header and silent token refresh on `401 TOKEN_EXPIRED` — nothing here needs to know that logic
exists).

```typescript
// lib/dashboard-api.ts
import { apiFetch } from "./api-client";
import type {
  Deployment,
  DeploymentDetail,
  LogLine,
  Project,
  ProjectWithLatestDeployment,
} from "./dashboard-types";

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? "Something went wrong. Please try again.");
  }
  return data as T;
}

// Projects

export async function listProjects(): Promise<ProjectWithLatestDeployment[]> {
  const res = await apiFetch("/api/projects");
  const data = await parseJson<{ projects: ProjectWithLatestDeployment[] }>(res);
  return data.projects;
}

export interface CreateProjectInput {
  name: string;
  repoUrl: string;
  defaultBranch?: string;
  description?: string;
  isPrivate?: boolean;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const res = await apiFetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

export async function getProject(projectId: string): Promise<Project> {
  const res = await apiFetch(`/api/projects/${projectId}`);
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

// Deployments

export async function createDeployment(projectId: string, branch?: string): Promise<Deployment> {
  const res = await apiFetch(`/api/projects/${projectId}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(branch ? { branch } : {}),
  });
  const data = await parseJson<{ deployment: Deployment }>(res);
  return data.deployment;
}

export async function listDeployments(
  projectId: string,
  opts: { cursor?: string; limit?: number } = {}
): Promise<{ deployments: Deployment[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));

  const res = await apiFetch(`/api/projects/${projectId}/deployments?${params}`);
  return parseJson(res);
}

export async function getDeployment(deploymentId: string): Promise<DeploymentDetail> {
  const res = await apiFetch(`/api/deployments/${deploymentId}`);
  const data = await parseJson<{ deployment: DeploymentDetail }>(res);
  return data.deployment;
}

export async function getDeploymentLogs(deploymentId: string, after = 0, limit = 500): Promise<LogLine[]> {
  const res = await apiFetch(`/api/deployments/${deploymentId}/logs?after=${after}&limit=${limit}`);
  const data = await parseJson<{ logs: LogLine[] }>(res);
  return data.logs;
}
```

### 1.3 `lib/config.ts` — one line added

```typescript
// lib/config.ts
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000/api";

// Socket.IO server — see api-server's src/realtime/index.ts (port 9002,
// unchanged from the original prototype's app/demo/page.tsx client).
export const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:9002";
```

### 1.4 `lib/format.ts`

A tiny formatting helper, kept separate from `dashboard-api.ts` on purpose — "how do I talk to the
API" and "how do I render a timestamp" are unrelated concerns, and a file named `dashboard-api.ts`
that also happened to own date formatting would be the first crack in the SRP discipline the backend
guide spent so much effort establishing.

```typescript
// lib/format.ts

/** "3h ago", "just now", etc. — falls back to a locale date past 30 days. */
export function formatRelativeTime(date: string | Date): string {
  const then = new Date(date).getTime();
  const diffSeconds = Math.round((Date.now() - then) / 1000);

  if (diffSeconds < 5) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  return new Date(date).toLocaleDateString();
}

/** "2m 34s", "45s", "1h 02m" — for buildDurationMs and the state timeline. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** "owner/repo" -> "repo" — used to auto-suggest a project name from a pasted GitHub URL. */
export function repoNameFromUrl(repoUrl: string): string {
  const match = repoUrl.match(/\/([^/]+?)(\.git)?\/?$/);
  return match?.[1] ?? "";
}

/**
 * Mirrors `slugifyProjectName` in the API's src/projects/project.service.ts
 * — same lowercase / collapse-non-alphanumeric / trim-hyphens rules — purely
 * so the new-project form can preview what the real slug will look like
 * before submitting. This is a PREVIEW ONLY: it can't know about collisions
 * (no DB access from the browser), so if the exact slug is already taken,
 * the actual created project gets `{preview}-{randomSuffix}` instead — the
 * form's helper text next to this says as much, deliberately, rather than
 * implying the preview is guaranteed.
 */
export function slugPreview(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}
```

### 1.5 `lib/use-deployment-socket.ts`

```typescript
// lib/use-deployment-socket.ts
"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { getAccessToken, onAccessTokenChange } from "./api-client";
import { SOCKET_URL } from "./config";
import type { DeploymentStatus, LogLine } from "./dashboard-types";

interface UseDeploymentSocketOptions {
  /** Skip connecting entirely if the deployment was already terminal on first load — no event will ever arrive. */
  enabled: boolean;
  onLog: (log: LogLine) => void;
  onStatus: (status: DeploymentStatus, url: string | null) => void;
}

/**
 * One socket per mounted log panel, joined to exactly one
 * `deployment:{id}` room — see api-server's src/realtime/socket.server.ts.
 * Mirrors the connect/subscribe pattern already proven out in
 * apps/frontend/app/demo/page.tsx, plus the access-token handshake that
 * page never needed (it predates auth entirely).
 */
export function useDeploymentSocket(deploymentId: string, { enabled, onLog, onStatus }: UseDeploymentSocketOptions) {
  const [connected, setConnected] = useState(false);

  // Refs, not dependencies — this hook re-renders far less than the
  // deployment detail page does (every new log line is a state update on
  // the PAGE, not here). Reading the latest callback through a ref instead
  // of re-subscribing the whole socket on every render is what keeps this
  // hook's effect dependency array down to just [deploymentId, enabled].
  const onLogRef = useRef(onLog);
  const onStatusRef = useRef(onStatus);
  onLogRef.current = onLog;
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!enabled) return;

    const socket: Socket = io(SOCKET_URL, { auth: { token: getAccessToken() } });

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("subscribe", deploymentId);
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("log", (log: LogLine) => onLogRef.current(log));
    socket.on("status", (e: { status: DeploymentStatus; url: string | null }) => {
      onStatusRef.current(e.status, e.url);
    });

    // If the in-memory access token rotates (apiFetch's silent refresh)
    // while this panel is open, update what the NEXT reconnect attempt
    // sends — Socket.IO re-reads socket.auth on every reconnect, so this is
    // enough to recover from a token rotation without forcing a disconnect
    // mid-stream.
    const unsubscribe = onAccessTokenChange((token) => {
      socket.auth = { token };
    });

    return () => {
      unsubscribe();
      socket.disconnect();
    };
  }, [deploymentId, enabled]);

  return { connected };
}
```

---

## 2. Shared components

### 2.1 `components/dashboard/StatusBadge.tsx`

Every `DeploymentStatus` value from the real enum, not a subset — a status the badge doesn't
recognize would silently render nothing, which is worse than an honest fallback.

```tsx
// components/dashboard/StatusBadge.tsx
import type { DeploymentStatus } from "../../lib/dashboard-types";

interface StatusConfig {
  label: string;
  color: string;
  bg: string;
  dot: string;
  pulse: boolean;
}

const STATUS_CONFIG: Record<DeploymentStatus, StatusConfig> = {
  QUEUED: { label: "Queued", color: "text-blue-400", bg: "bg-blue-400/10", dot: "bg-blue-400", pulse: false },
  BUILDING: { label: "Building", color: "text-amber-400", bg: "bg-amber-400/10", dot: "bg-amber-400", pulse: true },
  UPLOADING: { label: "Uploading", color: "text-purple-400", bg: "bg-purple-400/10", dot: "bg-purple-400", pulse: true },
  STARTING: { label: "Starting", color: "text-cyan-400", bg: "bg-cyan-400/10", dot: "bg-cyan-400", pulse: true },
  RUNNING: { label: "Running", color: "text-emerald-400", bg: "bg-emerald-400/10", dot: "bg-emerald-400", pulse: false },
  SLEEPING: { label: "Sleeping", color: "text-zinc-400", bg: "bg-zinc-400/10", dot: "bg-zinc-400", pulse: false },
  WAKING: { label: "Waking", color: "text-amber-400", bg: "bg-amber-400/10", dot: "bg-amber-400", pulse: true },
  STOPPED: { label: "Stopped", color: "text-zinc-500", bg: "bg-zinc-500/10", dot: "bg-zinc-500", pulse: false },
  FAILED: { label: "Failed", color: "text-red-400", bg: "bg-red-400/10", dot: "bg-red-400", pulse: false },
  CANCELLED: { label: "Cancelled", color: "text-zinc-500", bg: "bg-zinc-500/10", dot: "bg-zinc-500", pulse: false },
  ERROR: { label: "Error", color: "text-red-400", bg: "bg-red-400/10", dot: "bg-red-400", pulse: false },
};

export function StatusBadge({ status }: { status: DeploymentStatus }) {
  const config = STATUS_CONFIG[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${config.color} ${config.bg}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot} ${config.pulse ? "animate-pulse" : ""}`} />
      {config.label}
    </span>
  );
}
```

### 2.2 `components/dashboard/DashboardShell.tsx`

The topbar shell every `/dashboard/*` page renders inside (via `app/dashboard/layout.tsx`, §3.1).
Vercel's own dashboard uses a top navbar rather than a left sidebar for this exact view — logo, a
primary action, an account menu — which is the layout this follows, rather than the sidebar sketched
in generic dashboard mockups.

```tsx
// components/dashboard/DashboardShell.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, Monitor, Plus, Zap } from "lucide-react";
import { useAuth } from "../../app/providers";
import * as authApi from "../../lib/auth";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function handleLogout() {
    setSigningOut(true);
    await logout();
    router.push("/login");
  }

  async function handleLogoutAll() {
    setSigningOut(true);
    await authApi.logoutAll();
    router.push("/login");
  }

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <header className="border-b border-white/10 sticky top-0 bg-black/80 backdrop-blur-md z-20">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold tracking-tight">Dreamer</span>
          </Link>

          <div className="flex items-center gap-4">
            <Link
              href="/dashboard/new"
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/20 transition-all"
            >
              <Plus className="w-4 h-4" />
              New Project
            </Link>

            <div className="relative">
              <button
                onClick={() => setMenuOpen((open) => !open)}
                className="w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-medium text-zinc-300 hover:border-zinc-600 transition-colors"
              >
                {user?.name?.[0]?.toUpperCase() ?? "?"}
              </button>

              {menuOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl shadow-black/50 py-1.5 z-30">
                  <div className="px-3 py-2 border-b border-zinc-800">
                    <p className="text-sm font-medium text-zinc-200 truncate">{user?.name}</p>
                    <p className="text-xs text-zinc-500 truncate">{user?.email}</p>
                  </div>
                  <button
                    onClick={handleLogout}
                    disabled={signingOut}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900 transition-colors disabled:opacity-50"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign out
                  </button>
                  <button
                    onClick={handleLogoutAll}
                    disabled={signingOut}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    <Monitor className="w-4 h-4" />
                    Sign out of all devices
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">{children}</main>
    </div>
  );
}
```

### 2.3 `components/dashboard/ProjectCard.tsx`

```tsx
// components/dashboard/ProjectCard.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, GitBranch, Rocket } from "lucide-react";
import { createDeployment } from "../../lib/dashboard-api";
import { formatRelativeTime } from "../../lib/format";
import type { ProjectWithLatestDeployment } from "../../lib/dashboard-types";
import { StatusBadge } from "./StatusBadge";

export function ProjectCard({ project }: { project: ProjectWithLatestDeployment }) {
  const router = useRouter();
  const [deploying, setDeploying] = useState(false);
  const { latestDeployment } = project;

  // The card's own "Deploy" button — same endpoint the project overview
  // page's "Redeploy" button calls (createDeployment with no branch
  // override, defaulting server-side to the project's defaultBranch). One
  // action, reused everywhere it's offered, rather than a special
  // "quick-deploy" variant with its own behavior to keep in sync.
  async function handleQuickDeploy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDeploying(true);
    try {
      const deployment = await createDeployment(project.id);
      router.push(`/dashboard/projects/${project.id}/deployments/${deployment.id}`);
    } catch {
      setDeploying(false);
    }
  }

  return (
    <Link
      href={`/dashboard/projects/${project.id}`}
      className="block bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 hover:border-zinc-700 transition-colors group"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-zinc-100 group-hover:text-white">{project.name}</h3>
          <p className="text-xs text-zinc-500 font-mono">{project.slug}</p>
        </div>
        {latestDeployment ? (
          <StatusBadge status={latestDeployment.status} />
        ) : (
          <span className="text-xs text-zinc-500">No deploys yet</span>
        )}
      </div>

      {latestDeployment?.url && (
        <a
          href={latestDeployment.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 mb-3 truncate"
        >
          <ExternalLink className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{latestDeployment.url.replace(/^https?:\/\//, "")}</span>
        </a>
      )}

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <div className="flex items-center gap-1.5">
          <GitBranch className="w-3.5 h-3.5" />
          {project.defaultBranch}
        </div>
        <div className="flex items-center gap-3">
          <span>{project.deploymentCount} deploys</span>
          {latestDeployment && <span>{formatRelativeTime(latestDeployment.createdAt)}</span>}
        </div>
      </div>

      <button
        onClick={handleQuickDeploy}
        disabled={deploying}
        className="w-full mt-4 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-zinc-800 bg-zinc-900/60 text-sm font-medium text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors disabled:opacity-50"
      >
        <Rocket className="w-3.5 h-3.5" />
        {deploying ? "Queuing..." : "Deploy"}
      </button>
    </Link>
  );
}
```

### 2.4 `components/dashboard/EmptyState.tsx`

```tsx
// components/dashboard/EmptyState.tsx
import Link from "next/link";
import { Plus, Rocket } from "lucide-react";

export function EmptyProjectsState() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-24 border border-dashed border-zinc-800 rounded-2xl">
      <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
        <Rocket className="w-5 h-5 text-zinc-500" />
      </div>
      <h2 className="text-lg font-semibold text-zinc-200 mb-1">Deploy your first project</h2>
      <p className="text-sm text-zinc-500 mb-6 max-w-sm">
        Import a Git repository and Dreamer will clone, build, and deploy it for you.
      </p>
      <Link
        href="/dashboard/new"
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-medium shadow-lg shadow-blue-500/20 transition-all"
      >
        <Plus className="w-4 h-4" />
        New Project
      </Link>
    </div>
  );
}
```

### 2.5 `components/dashboard/DeploymentRow.tsx`

```tsx
// components/dashboard/DeploymentRow.tsx
import Link from "next/link";
import { GitCommitHorizontal } from "lucide-react";
import { formatRelativeTime } from "../../lib/format";
import type { Deployment } from "../../lib/dashboard-types";
import { StatusBadge } from "./StatusBadge";

export function DeploymentRow({ projectId, deployment }: { projectId: string; deployment: Deployment }) {
  return (
    <Link
      href={`/dashboard/projects/${projectId}/deployments/${deployment.id}`}
      className="flex items-center justify-between px-4 py-3 rounded-xl hover:bg-zinc-900/60 transition-colors border border-transparent hover:border-zinc-800"
    >
      <div className="flex items-center gap-3 min-w-0">
        <StatusBadge status={deployment.status} />
        <div className="min-w-0">
          <p className="text-sm text-zinc-200 truncate">{deployment.commitMessage ?? deployment.slug}</p>
          <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono">
            <GitCommitHorizontal className="w-3 h-3" />
            {deployment.commitHash ? deployment.commitHash.slice(0, 7) : deployment.branch}
          </div>
        </div>
      </div>
      <span className="text-xs text-zinc-500 shrink-0">{formatRelativeTime(deployment.createdAt)}</span>
    </Link>
  );
}
```

### 2.6 `components/dashboard/StateTimeline.tsx`

```tsx
// components/dashboard/StateTimeline.tsx
import type { StateTransition } from "../../lib/dashboard-types";
import { formatDuration } from "../../lib/format";

export function StateTimeline({ transitions }: { transitions: StateTransition[] }) {
  return (
    <div className="flex items-stretch overflow-x-auto pb-2">
      {transitions.map((transition, i) => {
        const next = transitions[i + 1];
        const durationMs = next
          ? new Date(next.createdAt).getTime() - new Date(transition.createdAt).getTime()
          : null;
        const isCurrent = !next;

        return (
          <div key={transition.id} className="flex items-center shrink-0">
            <div className="flex flex-col items-center px-3">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  isCurrent ? "bg-blue-400 animate-pulse" : "bg-zinc-600"
                }`}
              />
              <span className="text-xs font-medium text-zinc-300 mt-2 whitespace-nowrap">
                {transition.toStatus}
              </span>
              <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                {new Date(transition.createdAt).toLocaleTimeString()}
              </span>
            </div>
            {next && (
              <div className="flex flex-col items-center px-1 -mt-4">
                <div className="w-12 h-px bg-zinc-700" />
                {durationMs !== null && (
                  <span className="text-[10px] text-zinc-600 mt-1">{formatDuration(durationMs)}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

### 2.7 `components/dashboard/LogPanel.tsx` — revised to actually use `level` and `source`

The previous version of this component only used `log.level` to pick a text color and never rendered
`log.source` at all — which left two of the three fields the backend guide's build-engine change
(§4.0/§6 there) was specifically structured to provide completely unused. This revision is the actual
payoff of that decision: a level icon + colored chip (the same idea as Vercel's own build-log icons for
errors/warnings), a `source` tag per line (`build` vs `platform` vs `system` — distinguishing "this came
from your `npm run build`" from "this came from the deploy pipeline itself"), and level filter chips
next to the text filter, so a failed build can be narrowed to just `ERROR` lines in one click instead
of scrolling. None of this needed a new prop or a backend change — every field was already on
`LogLine`; it just wasn't being rendered.

Still purely presentational + its own local UI state (text filter, level filter, autoscroll) — it
receives `logs` and `isStreaming` as props and owns nothing about *how* those logs arrived. The
deployment detail page (§3.5) is the only thing that knows a socket exists.

```tsx
// components/dashboard/LogPanel.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Bug, Terminal } from "lucide-react";
import type { LogLine } from "../../lib/dashboard-types";

const LEVEL_CONFIG: Record<LogLine["level"], { color: string; icon: typeof AlertCircle | null }> = {
  ERROR: { color: "text-red-400", icon: AlertCircle },
  WARN: { color: "text-yellow-400", icon: AlertTriangle },
  SYSTEM: { color: "text-blue-400", icon: Terminal },
  DEBUG: { color: "text-zinc-500", icon: Bug },
  // INFO is the overwhelming majority of lines (raw build-tool stdout) — no
  // icon, so the eye isn't drawn to every single line, only the ones that
  // actually deviate from "normal."
  INFO: { color: "text-zinc-300", icon: null },
};

const LEVEL_FILTERS: Array<LogLine["level"] | "ALL"> = ["ALL", "ERROR", "WARN", "SYSTEM", "INFO", "DEBUG"];

export function LogPanel({ logs, isStreaming }: { logs: LogLine[]; isStreaming: boolean }) {
  const [textFilter, setTextFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<LogLine["level"] | "ALL">("ALL");
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoScroll) return;
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: "smooth" });
  }, [logs, autoScroll]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (levelFilter !== "ALL" && log.level !== levelFilter) return false;
      if (textFilter && !log.message.toLowerCase().includes(textFilter.toLowerCase())) return false;
      return true;
    });
  }, [logs, levelFilter, textFilter]);

  const errorCount = useMemo(() => logs.filter((l) => l.level === "ERROR").length, [logs]);

  return (
    <div className="flex flex-col h-[480px] bg-black/40 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-950/60">
        <input
          placeholder="Filter logs..."
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          className="flex-1 bg-transparent text-sm outline-none text-zinc-200 placeholder:text-zinc-600 min-w-0"
        />
        {isStreaming && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </span>
        )}
        {errorCount > 0 && (
          <span className="text-xs text-red-400 shrink-0">
            {errorCount} error{errorCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="text-xs text-zinc-500 shrink-0">{filteredLogs.length} lines</span>
      </div>

      {/* Level filter chips — the direct payoff of `level` being a real
          structured field instead of buried in free-text: narrowing to just
          ERROR lines after a failed build is one click, not a scroll. */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-800/60 overflow-x-auto">
        {LEVEL_FILTERS.map((level) => (
          <button
            key={level}
            onClick={() => setLevelFilter(level)}
            className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap transition-colors ${
              levelFilter === level
                ? "bg-zinc-100 text-zinc-900 border-zinc-100"
                : "text-zinc-400 border-zinc-800 hover:border-zinc-700"
            }`}
          >
            {level}
          </button>
        ))}
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-3 font-mono text-[13px] scrollbar-visible"
        onScroll={(e) => {
          const el = e.currentTarget;
          const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 24;
          setAutoScroll(isAtBottom);
        }}
      >
        {filteredLogs.length === 0 && (
          <p className="text-zinc-600 text-sm">
            {logs.length === 0 ? "Waiting for logs..." : "No lines match the current filter."}
          </p>
        )}
        {filteredLogs.map((log) => {
          const { color, icon: Icon } = LEVEL_CONFIG[log.level];
          return (
            <div key={log.id} className={`flex items-start gap-3 py-0.5 ${color}`}>
              <span className="text-zinc-600 select-none w-12 shrink-0 text-right">{log.sequence}</span>
              <span className="text-zinc-600 select-none w-20 shrink-0">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              {Icon ? <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <span className="w-3.5 shrink-0" />}
              {log.source && (
                <span className="shrink-0 px-1.5 rounded bg-zinc-800/80 text-[10px] uppercase tracking-wide text-zinc-400 h-fit leading-[1.4]">
                  {log.source}
                </span>
              )}
              <span className="break-all whitespace-pre-wrap">{log.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

## 3. Pages

### 3.1 `app/dashboard/layout.tsx`

A plain Server Component — like the root `app/layout.tsx` already is — composing two Client
Components. Next.js allows this freely (a server component rendering client children, even passing
`children` through another client component); it's the cleanest way to keep the auth guard and shell
in exactly one file for the whole `/dashboard/*` subtree.

```tsx
// app/dashboard/layout.tsx
import { RequireAuth } from "../require-auth";
import { DashboardShell } from "../../components/dashboard/DashboardShell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <DashboardShell>{children}</DashboardShell>
    </RequireAuth>
  );
}
```

### 3.2 `app/dashboard/page.tsx` — REWRITTEN

The old version of this file was a single-account-info demo page (it proved `GET /api/auth/me` worked
end-to-end, which was the right thing to build *before* there was a real dashboard to put it in). It's
now the actual dashboard home: every project the user owns, each with a live-enough status badge with
zero extra requests (`listProjects()` already returns each project's latest deployment in one round
trip — see `project.service.ts`'s `listProjectsForUser` in the backend guide).

```tsx
// app/dashboard/page.tsx
"use client";

import { useEffect, useState } from "react";
import { listProjects } from "../../lib/dashboard-api";
import type { ProjectWithLatestDeployment } from "../../lib/dashboard-types";
import { ProjectCard } from "../../components/dashboard/ProjectCard";
import { EmptyProjectsState } from "../../components/dashboard/EmptyState";

export default function DashboardPage() {
  const [projects, setProjects] = useState<ProjectWithLatestDeployment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load projects"));
  }, []);

  if (error) {
    return <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">{error}</p>;
  }

  if (!projects) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-44 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (projects.length === 0) return <EmptyProjectsState />;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Projects</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>
    </div>
  );
}
```

### 3.3 `app/dashboard/new/page.tsx`

The "Import Git Repository" flow. Two sequential calls, deliberately not one combined backend
endpoint — `createProject` and `createDeployment` are independently useful (the project overview
page's "Redeploy" button calls only the second one), so composing them here, at the one call site that
actually needs both in sequence, keeps each backend endpoint doing exactly one thing. The project name
auto-fills from the repo URL the same way Vercel's own import flow does, but stays editable.

Two additions from the original version of this page: a **Private repository** checkbox (the form
never actually collected `isPrivate` before, which meant the backend's whole private-repo path — §3.7
of the backend guide — could never be reached from the UI at all), and special handling for the
`GITHUB_NOT_CONNECTED` error code: instead of a generic red error box, it's a one-click "Connect
GitHub" link straight to the existing OAuth route. There's also a live slug preview — since the
project's slug is now derived from its name (backend guide §2.2) rather than a random string, showing
it before submission means the user sees exactly what they're going to get, including the
collision-suffix case, instead of being surprised by it after the fact.

```tsx
// app/dashboard/new/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Github, Loader2 } from "lucide-react";
import { createDeployment, createProject } from "../../../lib/dashboard-api";
import { repoNameFromUrl, slugPreview } from "../../../lib/format";
import { API_BASE_URL } from "../../../lib/config";

export default function NewProjectPage() {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsGithubConnect, setNeedsGithubConnect] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function handleRepoUrlChange(value: string) {
    setRepoUrl(value);
    // Auto-suggest a name from the URL until the user types their own —
    // mirrors Vercel's own "Import" screen, where the project name field
    // pre-fills from the repo but is always yours to override.
    if (!nameTouched) setName(repoNameFromUrl(value));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNeedsGithubConnect(false);
    setSubmitting(true);

    try {
      const project = await createProject({
        name,
        repoUrl,
        defaultBranch,
        description: description || undefined,
        isPrivate,
      });
      const deployment = await createDeployment(project.id);
      router.push(`/dashboard/projects/${project.id}/deployments/${deployment.id}`);
    } catch (err) {
      // GITHUB_NOT_CONNECTED isn't really an "error to read," it's a missing
      // step — surfacing it as a direct fix (a link, not just red text) is
      // worth special-casing this one code rather than treating it like any
      // other failed request. apiFetch's thrown Error only ever carries
      // `message`, not the original `code`, so this matches on the message
      // text the backend sends for that specific case (deployment.service.ts
      // §3.7) — slightly stringly-typed, but it's one string in one place.
      const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      if (message.includes("Connect your GitHub account")) {
        setNeedsGithubConnect(true);
      } else {
        setError(message);
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold mb-1">Import Git Repository</h1>
      <p className="text-zinc-400 text-sm mb-8">Dreamer will clone, build, and deploy it for you.</p>

      <form onSubmit={handleSubmit} className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-6 flex flex-col gap-4">
        <div>
          <label htmlFor="repoUrl" className="block text-xs font-medium text-zinc-400 mb-1.5">
            Repository URL
          </label>
          <input
            id="repoUrl"
            type="url"
            required
            value={repoUrl}
            onChange={(e) => handleRepoUrlChange(e.target.value)}
            placeholder="https://github.com/you/your-app"
            className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors font-mono"
          />
        </div>

        <div>
          <label htmlFor="name" className="block text-xs font-medium text-zinc-400 mb-1.5">
            Project Name
          </label>
          <input
            id="name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
          {name && (
            <p className="text-xs text-zinc-500 mt-1.5 font-mono">
              {slugPreview(name)} <span className="text-zinc-600">— exact match if available, otherwise +random suffix</span>
            </p>
          )}
        </div>

        <div>
          <label htmlFor="branch" className="block text-xs font-medium text-zinc-400 mb-1.5">
            Production Branch
          </label>
          <input
            id="branch"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
        </div>

        <div>
          <label htmlFor="description" className="block text-xs font-medium text-zinc-400 mb-1.5">
            Description <span className="text-zinc-600">(optional)</span>
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors resize-none"
          />
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-blue-500/50 focus:ring-offset-0"
          />
          <span className="text-sm text-zinc-300">This is a private repository</span>
        </label>

        {needsGithubConnect && (
          <div className="flex items-center justify-between gap-3 text-sm bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
            <span className="text-amber-200">Connect your GitHub account to deploy private repositories.</span>
            {/* Full page navigation, not apiFetch — this is the existing
                redirect-based OAuth flow (auth/auth.routes.ts's GET
                /api/auth/github), the same button login/page.tsx already
                uses. Re-running it also transparently upgrades an
                already-connected account to the wider `repo` scope from
                backend guide §3.7, if it was connected before that change. */}
            <a
              href={`${API_BASE_URL}/auth/github`}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-100 text-zinc-900 text-xs font-medium hover:bg-white transition-colors"
            >
              <Github className="w-3.5 h-3.5" />
              Connect GitHub
            </a>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="flex items-center justify-center gap-2 w-full py-2.5 mt-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-60 text-white font-medium rounded-lg shadow-lg shadow-blue-500/20 transition-all"
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              Deploy
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}
```

> Returning to a page after a GitHub-connect redirect loses whatever was typed into the form — the
> full-page navigation in `needsGithubConnect` isn't a modal, it leaves this page entirely. Acceptable
> for a first pass (the user re-enters a few fields), but if it's worth smoothing over later, the fix is
> sessionStorage-free: pass the in-progress form values as URL query params on the way out and read
> them back via `useSearchParams` on the way in, since nothing here is sensitive enough to avoid putting
> in a URL.

### 3.4 `app/dashboard/projects/[projectId]/page.tsx`

```tsx
// app/dashboard/projects/[projectId]/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ExternalLink, GitBranch, Rocket } from "lucide-react";
import { createDeployment, getProject, listDeployments } from "../../../../lib/dashboard-api";
import type { Deployment, Project } from "../../../../lib/dashboard-types";
import { DeploymentRow } from "../../../../components/dashboard/DeploymentRow";
import { StatusBadge } from "../../../../components/dashboard/StatusBadge";

export default function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getProject(projectId), listDeployments(projectId, { limit: 10 })])
      .then(([projectData, { deployments }]) => {
        setProject(projectData);
        setDeployments(deployments);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load project"));
  }, [projectId]);

  async function handleDeploy() {
    setDeploying(true);
    try {
      const deployment = await createDeployment(projectId);
      router.push(`/dashboard/projects/${projectId}/deployments/${deployment.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start deployment");
      setDeploying(false);
    }
  }

  if (error) {
    return <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">{error}</p>;
  }

  if (!project || !deployments) {
    return <div className="h-64 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />;
  }

  const activeDeployment = deployments.find((d) => d.id === project.activeDeploymentId);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">{project.name}</h1>
        <button
          onClick={handleDeploy}
          disabled={deploying}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-medium shadow-lg shadow-blue-500/20 transition-all disabled:opacity-60"
        >
          <Rocket className="w-3.5 h-3.5" />
          {deploying ? "Queuing..." : "Redeploy"}
        </button>
      </div>
      <a
        href={project.repoUrl}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 mb-8 font-mono"
      >
        {project.repoFullName ?? project.repoUrl}
        <ExternalLink className="w-3 h-3" />
      </a>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 mb-6">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              Active Deployment
            </h2>
            {activeDeployment ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <StatusBadge status={activeDeployment.status} />
                  {activeDeployment.url && (
                    <a
                      href={activeDeployment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-blue-400 hover:text-blue-300"
                    >
                      {activeDeployment.url.replace(/^https?:\/\//, "")}
                    </a>
                  )}
                </div>
                {activeDeployment.buildDurationMs && (
                  <span className="text-xs text-zinc-500">
                    Built in {Math.round(activeDeployment.buildDurationMs / 1000)}s
                  </span>
                )}
              </div>
            ) : (
              <p className="text-sm text-zinc-500">No deployment is live yet.</p>
            )}
          </div>

          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3 px-1">
            Recent Deployments
          </h2>
          <div className="flex flex-col gap-1">
            {deployments.length === 0 && (
              <p className="text-sm text-zinc-500 px-1">No deployments yet. Click Redeploy to get started.</p>
            )}
            {deployments.map((deployment) => (
              <DeploymentRow key={deployment.id} projectId={project.id} deployment={deployment} />
            ))}
          </div>
        </div>

        <div>
          <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Repository</h2>
            <dl className="text-sm flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <dt className="text-zinc-500">Branch</dt>
                <dd className="flex items-center gap-1.5 font-mono text-zinc-300">
                  <GitBranch className="w-3.5 h-3.5" />
                  {project.defaultBranch}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-zinc-500">Total deploys</dt>
                <dd className="text-zinc-300">{deployments.length}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
```

### 3.5 `app/dashboard/projects/[projectId]/deployments/[deploymentId]/page.tsx`

The page that ties §1's socket hook and §2's `LogPanel`/`StateTimeline` together. On mount: fetch the
deployment detail (status + transitions) and the logs persisted so far over plain REST — exactly the
"no flash, DB is the source of truth for replay" requirement — then, only if the deployment wasn't
*already* terminal on load, open the socket and append anything that arrives live.

```tsx
// app/dashboard/projects/[projectId]/deployments/[deploymentId]/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Copy, ExternalLink } from "lucide-react";
import { getDeployment, getDeploymentLogs } from "../../../../../../lib/dashboard-api";
import { TERMINAL_STATUSES } from "../../../../../../lib/dashboard-types";
import type { DeploymentDetail, DeploymentStatus, LogLine } from "../../../../../../lib/dashboard-types";
import { useDeploymentSocket } from "../../../../../../lib/use-deployment-socket";
import { LogPanel } from "../../../../../../components/dashboard/LogPanel";
import { StateTimeline } from "../../../../../../components/dashboard/StateTimeline";
import { StatusBadge } from "../../../../../../components/dashboard/StatusBadge";

export default function DeploymentDetailPage() {
  const { deploymentId } = useParams<{ deploymentId: string }>();

  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getDeployment(deploymentId), getDeploymentLogs(deploymentId)])
      .then(([deploymentData, logData]) => {
        setDeployment(deploymentData);
        setLogs(logData);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load deployment"));
  }, [deploymentId]);

  const handleLog = useCallback((log: LogLine) => {
    // The realtime gateway can theoretically redeliver a line (e.g. a
    // reconnect that re-subscribes mid-stream) — de-dup by sequence rather
    // than trusting "exactly once" from a pub/sub channel that makes no such
    // guarantee.
    setLogs((prev) => (prev.some((l) => l.sequence === log.sequence) ? prev : [...prev, log]));
  }, []);

  const handleStatus = useCallback((status: DeploymentStatus, url: string | null) => {
    setDeployment((prev) => (prev ? { ...prev, status, url: url ?? prev.url } : prev));
  }, []);

  const isTerminalOnLoad = deployment ? TERMINAL_STATUSES.includes(deployment.status) : false;

  useDeploymentSocket(deploymentId, {
    enabled: Boolean(deployment) && !isTerminalOnLoad,
    onLog: handleLog,
    onStatus: handleStatus,
  });

  if (error) {
    return <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">{error}</p>;
  }

  if (!deployment) {
    return <div className="h-64 rounded-2xl border border-zinc-800 bg-zinc-950/40 animate-pulse" />;
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-xl font-bold font-mono">{deployment.slug}</h1>
        <StatusBadge status={deployment.status} />
      </div>

      {deployment.url && (
        <div className="flex items-center gap-2 mb-6">
          <a href={deployment.url} target="_blank" rel="noreferrer" className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1">
            {deployment.url}
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => navigator.clipboard.writeText(deployment.url!)}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="Copy URL"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {deployment.errorMessage && (
        <div className="mb-6 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
          <p className="font-medium mb-0.5">{deployment.errorCode}</p>
          <p>{deployment.errorMessage}</p>
        </div>
      )}

      <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 mb-6 overflow-x-auto">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Timeline</h2>
        <StateTimeline transitions={deployment.stateTransitions} />
      </div>

      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3 px-1">Build Logs</h2>
      <LogPanel logs={logs} isStreaming={!isTerminalOnLoad} />
    </div>
  );
}
```

> The deep file-nesting (`../../../../../../lib/...`) is the one real cost of putting deployment detail
> four segments deep under `/dashboard`. If that bothers you more than the layout-sharing benefit from
> §0.2 is worth, add a `tsconfig.json` path alias (`"@/*": ["./*"]`) and use `@/lib/dashboard-api`
> everywhere instead — a five-minute change that doesn't affect anything else in this guide.

---

## 4. Manual end-to-end test

1. `npm run dev` in `apps/api-server` and `apps/frontend` (and make sure Redis + an ECS-reachable AWS
   credential are configured — or skip step 3 and just confirm the `QUEUED` row + transition append
   correctly without a real build, by temporarily pointing `ECS_CLUSTER_ARN` at a placeholder and
   reading the `FAILED`/`ENGINE_LAUNCH_FAILED` deployment that results, which is itself a confirmation
   the whole creation path through `createDeployment`'s catch block works).
2. Log in, land on `/dashboard` → empty state → **New Project** → paste a real public repo URL →
   **Deploy**.
3. You should land on the deployment detail page immediately, status `QUEUED`, timeline showing one
   node. Within seconds: `BUILDING` (live, no refresh), log lines streaming in from `npm install`.
4. On success: `UPLOADING` → `RUNNING`, a clickable live URL appears, the "Live" indicator in the log
   panel disappears once the deployment hits a terminal state.
5. Go back to `/dashboard` — the project card now shows the `RUNNING` badge and the live URL, with zero
   additional requests beyond the one `listProjects()` call.
6. Reload the deployment detail page directly (no socket connection has happened yet on this load) —
   logs and the timeline are still there, served entirely from Postgres. This is the "DB is the source
   of truth for replay" guarantee, proven, not just asserted.

---

## 5. SOLID / LLD on the frontend side

**Single Responsibility, container vs. presentational.** `LogPanel` knows nothing about sockets; the
deployment detail page knows nothing about scroll-position math. Swapping the realtime transport later
(per the backend guide's note on SSE) would mean editing `use-deployment-socket.ts` and the page that
calls it — `LogPanel.tsx` would not need to change at all, because it never depended on *how* logs
arrive, only on receiving an array of them.

**Dependency direction mirrors the backend's.** `dashboard-api.ts` is the only file that knows the
actual HTTP shape of any endpoint. Every page and component depends on its typed return values, never
on `fetch` or `apiFetch` directly — the same inversion as `deployment.service.ts` depending on
`DeploymentEngine` rather than the AWS SDK. If the API's response envelope ever changes shape, exactly
one file needs to change.

**Open/Closed at the badge boundary.** Adding a twelfth `DeploymentStatus` value to the schema someday
is a one-line addition to `STATUS_CONFIG` in `StatusBadge.tsx` and to the union type in
`dashboard-types.ts` — every page that renders a badge is unaffected, because none of them branch on
status themselves; they all just render `<StatusBadge status={...} />` and trust it to know what to do.
