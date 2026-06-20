# Dreamer Frontend Auth — Login, Register, GitHub OAuth, Protected Routes

Same standard as the API guide

## 1. The shared GitHub icon

The `landingpage.tsx` already had a hand-rolled GitHub icon defined inline. The auth pages need the
same icon, so it's worth pulling out once rather than copy-pasting the SVG path data a third time.

```tsx
// components/icons.tsx
import React from "react";

export function GithubIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}
```

In `app/landingpage.tsx`, delete the inline `const Github = ...` definition and import this instead:

```diff
+ import { GithubIcon as Github } from "../components/icons";
+ import { useAuth } from "./providers";
+ import { useRouter } from "next/navigation";
- 
- const Github = (props: React.SVGProps<SVGSVGElement>) => ( ... );
```

(aliased to `Github` so every existing `<Github ... />` usage in that 1000-line file needs zero
other changes.)

---

## 2. `lib/api-client.ts` — fixed and made the single source of truth

```typescript
// lib/api-client.ts
import { API_BASE_URL } from "./config";

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;
const listeners = new Set<(token: string | null) => void>();

export function setAccessToken(token: string | null) {
  accessToken = token;
  listeners.forEach((listener) => listener(token));
}

export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Lets the AuthProvider's React state stay in sync with this module's token,
 * including when apiFetch silently refreshes it below — without this, a
 * background refresh would update the token used for API calls but never
 * tell the UI, leaving stale state on screen.
 */
export function onAccessTokenChange(listener: (token: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function refreshAccessToken(): Promise<string | null> {
  const res = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
    method: "POST",
    credentials: "include", // sends the httpOnly refreshToken cookie
  });

  if (!res.ok) {
    setAccessToken(null);
    return null;
  }

  const data = await res.json();
  setAccessToken(data.accessToken);
  return data.accessToken;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const doFetch = (token: string | null) =>
    fetch(`${API_BASE_URL}${path}`, {
      ...options,
      credentials: "include",
      headers: { ...options.headers, Authorization: token ? `Bearer ${token}` : "" },
    });

  let res = await doFetch(accessToken);

  if (res.status === 401) {
    // .clone() because the body can only be read once — if this isn't a
    // refreshable case, the caller still needs to read the original error.
    const body = await res
      .clone()
      .json()
      .catch(() => null);

    if (body?.code === "TOKEN_EXPIRED") {
      // Coalesce concurrent refreshes — if five requests 401 at once, only one
      // network call to /refresh happens; the other four await the same promise.
      refreshPromise ??= refreshAccessToken().finally(() => {
        refreshPromise = null;
      });

      const newToken = await refreshPromise;
      if (newToken) res = await doFetch(newToken);
    }
  }

  return res;
}
```

The `.clone()` is a real fix, not a style preference: a `Response` body can only be read once. The
version that existed before called `res.json()` directly to peek at the error `code` — which meant
if the 401 *wasn't* a `TOKEN_EXPIRED` case (say, a suspended account), the body was already
consumed and the caller's own `res.json()` would throw or return nothing.

---

## 3. `lib/auth.ts` — new: a typed client for every auth endpoint

This mirrors the API's own `auth.controller.ts` endpoint-for-endpoint, the same way the API's
`auth.service.ts` mirrors `auth.tokens.ts` — each layer one level more specific than the one below.

```typescript
// lib/auth.ts
import { API_BASE_URL } from "./config";
import { apiFetch, setAccessToken } from "./api-client";

// Mirrors PublicUser from the API's src/auth/auth.types.ts — keep these in sync.
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  githubUsername: string | null;
  emailVerified: boolean;
}

interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}

async function parseAuthResponse(res: Response): Promise<AuthResponse> {
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(data?.error ?? "Something went wrong. Please try again.");
  }

  return data as AuthResponse;
}

export async function register(name: string, email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE_URL}/api/auth/register`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });

  const data = await parseAuthResponse(res);
  setAccessToken(data.accessToken);
  return data;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const data = await parseAuthResponse(res);
  setAccessToken(data.accessToken);
  return data;
}

/**
 * Exchanges the httpOnly refresh cookie for a fresh access token.
 * Called on every app boot (to restore a session silently) and again on
 * /auth/callback right after a GitHub login redirect.
 */
export async function refresh(): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });

  const data = await parseAuthResponse(res);
  setAccessToken(data.accessToken);
  return data;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE_URL}/api/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
  setAccessToken(null);
}

/** "Sign out of all devices" — exercises requireAuth on the API via apiFetch. */
export async function logoutAll(): Promise<void> {
  await apiFetch("/api/auth/logout-all", { method: "POST" });
  setAccessToken(null);
}

/** Full-page navigation target for the "Continue with GitHub" button — never fetch() this. */
export function githubLoginUrl(): string {
  return `${API_BASE_URL}/api/auth/github`;
}
```

---

## 4. `app/providers.tsx` — the rewritten AuthProvider

```tsx
// app/providers.tsx
"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import { onAccessTokenChange, setAccessToken as setClientAccessToken } from "../lib/api-client";
import * as authApi from "../lib/auth";
import type { AuthUser } from "../lib/auth";

interface AuthContextType {
  user: AuthUser | null;
  accessToken: string | null;
  /** True until the initial silent-refresh-on-mount has resolved. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-runs the same cookie-to-access-token exchange used on boot. Used by /auth/callback after GitHub OAuth. */
  refreshSession: () => Promise<void>;
  githubLoginUrl: string;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <Providers>");
  return ctx;
}

export function Providers({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessTokenState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // api-client.ts is the single source of truth for the in-memory access
  // token (apiFetch reads it directly from there for every request). This
  // keeps this component's state — and therefore every re-render that
  // depends on it — in sync whenever that token changes, including from
  // apiFetch's own silent background refresh, not just from calls made here.
  useEffect(() => onAccessTokenChange(setAccessTokenState), []);

  const refreshSession = useCallback(async () => {
    try {
      const data = await authApi.refresh();
      setUser(data.user);
    } catch {
      setUser(null);
    }
  }, []);

  // On first load, try to turn an existing httpOnly refresh cookie into a
  // fresh access token — this is what keeps someone logged in across a
  // page reload without ever putting a token in localStorage.
  useEffect(() => {
    refreshSession().finally(() => setLoading(false));
  }, [refreshSession]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await authApi.login(email, password);
    setUser(data.user);
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const data = await authApi.register(name, email, password);
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setClientAccessToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        loading,
        login,
        register,
        logout,
        refreshSession,
        githubLoginUrl: authApi.githubLoginUrl(),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
```

`refreshSession` is exposed on the context (not just used internally) for a specific reason covered
in Section 7's callback page — and it's the kind of seam worth having even before you need it again
(a "retry" button after a failed background refresh, for instance).

`layout.tsx` doesn't need any changes — it already wraps `children` in `<Providers>`.

---

## 5. `app/require-auth.tsx` — new: the client-side route guard

```tsx
// app/require-auth.tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./providers";

function FullPageSpinner() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-white/20 border-t-blue-500 rounded-full animate-spin" />
    </div>
  );
}

/**
 * Wrap any page that requires a logged-in user with this. It's a CLIENT-side
 * check on purpose — see Section 0 for why a proxy.ts cookie check would not
 * actually work for this architecture (the refresh cookie is scoped to the
 * API's own host, not the frontend's).
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) return <FullPageSpinner />;

  return <>{children}</>;
}
```

Live-tested: hitting `/dashboard` with no session returns the spinner markup in the server-rendered
HTML (confirmed via `curl` — no flash of the real dashboard content, ever, even before any
JavaScript runs).

---

## 6. `app/login/page.tsx` and `app/register/page.tsx`

The login page reads `?error=` (set by the API when a GitHub login fails) and `?redirect=` (where
to land after a successful login) — both via `useSearchParams()`, which is why it needs the
`<Suspense>` wrapper this page has, with a skeleton fallback shaped exactly like the real form so
there's no layout shift or blank flash during hydration (this is also the literal pattern shown in
Next's own `useSearchParams` docs — I checked).

```tsx
// app/login/page.tsx
"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Zap, ArrowRight, Loader2 } from "lucide-react";
import { GithubIcon } from "../../components/icons";
import { useAuth } from "../providers";

const ERROR_MESSAGES: Record<string, string> = {
  github_state_mismatch: "Your GitHub sign-in session expired before it could finish. Please try again.",
  github_auth_failed: "GitHub sign-in didn't go through. Please try again.",
  session_failed: "We couldn't restore your session. Please sign in again.",
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, githubLoginUrl, user, loading } = useAuth();

  const redirectTo = searchParams.get("redirect") || "/dashboard";
  const queryError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    queryError ? ERROR_MESSAGES[queryError] ?? "Something went wrong. Please try again." : null
  );
  const [submitting, setSubmitting] = useState(false);

  // Already signed in (e.g. hit the back button after logging in) — skip the form.
  useEffect(() => {
    if (!loading && user) router.replace(redirectTo);
  }, [loading, user, router, redirectTo]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login(email, password);
      router.push(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col items-center mb-8">
        <Link href="/" className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
            Dreamer
          </span>
        </Link>
        <h1 className="text-2xl font-bold text-white">Welcome back</h1>
        <p className="text-zinc-400 text-sm mt-1">Sign in to your console</p>
      </div>

      <div className="bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6">
        <a
          href={githubLoginUrl}
          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg border border-white/10 bg-white/5 text-sm font-medium text-zinc-200 hover:bg-white/10 hover:text-white transition-colors"
        >
          <GithubIcon className="w-4 h-4" />
          Continue with GitHub
        </a>

        <div className="flex items-center gap-3 my-5">
          <div className="h-px flex-1 bg-zinc-800" />
          <span className="text-xs text-zinc-500">OR</span>
          <div className="h-px flex-1 bg-zinc-800" />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="email" className="block text-xs font-medium text-zinc-400 mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-medium text-zinc-400 mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
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
                Sign in
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </div>

      <p className="text-center text-sm text-zinc-500 mt-6">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="text-blue-400 hover:text-blue-300 font-medium">
          Sign up
        </Link>
      </p>
    </div>
  );
}

// Same outer shape as the real form (logo, heading, card, button) so
// hydration swaps content in-place with zero layout shift — a blank
// fallback would otherwise flash for a frame on every static page load,
// per Next's own guidance on useSearchParams + Suspense.
function LoginSkeleton() {
  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col items-center mb-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
            Dreamer
          </span>
        </div>
        <h1 className="text-2xl font-bold text-white">Welcome back</h1>
        <p className="text-zinc-400 text-sm mt-1">Sign in to your console</p>
      </div>

      <div className="bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6">
        <div className="h-[42px] rounded-lg border border-white/10 bg-white/5 animate-pulse" />
        <div className="flex items-center gap-3 my-5">
          <div className="h-px flex-1 bg-zinc-800" />
          <span className="text-xs text-zinc-500">OR</span>
          <div className="h-px flex-1 bg-zinc-800" />
        </div>
        <div className="flex flex-col gap-4">
          <div className="h-[60px] rounded-lg bg-zinc-900 border border-zinc-800 animate-pulse" />
          <div className="h-[60px] rounded-lg bg-zinc-900 border border-zinc-800 animate-pulse" />
          <div className="h-[42px] rounded-lg bg-zinc-800 animate-pulse mt-1" />
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-black flex items-center justify-center px-6 py-12">
      <Suspense fallback={<LoginSkeleton />}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
```

Note the GitHub button is a plain `<a href>`, never a `fetch()` or an `onClick` handler that fetches
— it has to be a real, full-page browser navigation, because what follows is GitHub's own consent
screen, which can't be loaded inside a same-origin XHR.

`register/page.tsx` is the same shell with a `name` field added and no query params to read, so no
`Suspense` is needed there:

```tsx
// app/register/page.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Zap, ArrowRight, Loader2 } from "lucide-react";
import { GithubIcon } from "../../components/icons";
import { useAuth } from "../providers";

export default function RegisterPage() {
  const router = useRouter();
  const { register, githubLoginUrl, user, loading } = useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await register(name, email, password);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-black flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Link href="/" className="flex items-center gap-3 mb-6">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
              Dreamer
            </span>
          </Link>
          <h1 className="text-2xl font-bold text-white">Create your account</h1>
          <p className="text-zinc-400 text-sm mt-1">Start deploying in minutes</p>
        </div>

        <div className="bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6">
          <a
            href={githubLoginUrl}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg border border-white/10 bg-white/5 text-sm font-medium text-zinc-200 hover:bg-white/10 hover:text-white transition-colors"
          >
            <GithubIcon className="w-4 h-4" />
            Continue with GitHub
          </a>

          <div className="flex items-center gap-3 my-5">
            <div className="h-px flex-1 bg-zinc-800" />
            <span className="text-xs text-zinc-500">OR</span>
            <div className="h-px flex-1 bg-zinc-800" />
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label htmlFor="name" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Name
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
                placeholder="Saman Pandey"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
                placeholder="At least 8 characters"
              />
            </div>

            {error && (
              <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
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
                  Create account
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-zinc-500 mt-6">
          Already have an account?{" "}
          <Link href="/login" className="text-blue-400 hover:text-blue-300 font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
```

---

## 7. `app/auth/callback/page.tsx` — landing page for the GitHub redirect

This is the piece that took two passes to get right, and the reasoning is worth following closely
because the wrong version *looks* correct and only fails intermittently.

My first instinct was to have this page call `authApi.refresh()` itself on mount. That's wrong: the
root `<Providers>` *also* runs a refresh-on-mount, and a full-page redirect from GitHub through your
API back to this page is a fresh page load — so `<Providers>` mounts fresh here too. That's **two**
concurrent calls to `POST /api/auth/refresh` racing each other. Your API rotates the session on
every refresh (by design — that's what makes a stolen old refresh token useless). Two simultaneous
calls means whichever request's `Cookie` header was captured by the browser *first* wins; the
second arrives carrying a refresh token the first call has already deleted, and gets a `401`. That
makes GitHub login intermittently fail, in a way that would be maddening to debug later, since it'd
look like a backend bug that happens "sometimes."

The fix: don't call refresh here at all. Just wait for the one call `<Providers>` is already making,
and react to its result.

```tsx
// app/auth/callback/page.tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../providers";

/**
 * The API's /api/auth/github/callback redirects the browser HERE on success,
 * after setting the httpOnly refreshToken cookie — deliberately without an
 * access token in the URL (see the API-side write-up for why).
 *
 * This page does NOT call refresh() itself. <Providers> already runs that
 * exact exchange once on every fresh page load (this redirect is a full page
 * navigation, so Providers mounts fresh here too) — calling it a second time
 * here would race the server's refresh-token ROTATION and could intermittently
 * fail. Instead this page just waits for that one shared call to resolve.
 */
export default function GithubCallbackPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? "/dashboard" : "/login?error=session_failed");
  }, [loading, user, router]);

  return (
    <main className="min-h-screen bg-black flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-white/20 border-t-blue-500 rounded-full animate-spin" />
        <p className="text-zinc-400 text-sm">Finishing sign-in...</p>
      </div>
    </main>
  );
}
```

This is also why `refreshSession` is exposed on the auth context from Section 4 even though this
page ends up not calling it directly — I built the first version that way before catching the race,
and I'm leaving the seam there because it's a legitimately useful escape hatch (e.g. a manual
"retry" button somewhere) now that it's understood *not* to be the right tool for this particular
page.

---

## 8. `app/dashboard/page.tsx` — the protected page proving all of it works

```tsx
// app/dashboard/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Zap, LogOut, Monitor, CheckCircle2, CircleDashed } from "lucide-react";
import { GithubIcon } from "../../components/icons";
import { useAuth } from "../providers";
import { RequireAuth } from "../require-auth";
import { apiFetch } from "../../lib/api-client";
import type { AuthUser } from "../../lib/auth";
import * as authApi from "../../lib/auth";

function DashboardContent() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [verifiedUser, setVerifiedUser] = useState<AuthUser | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Proves the Bearer-token path end-to-end: this hits a route protected by
  // requireAuth on the API, using the access token apiFetch already holds —
  // separate from the cookie-based check RequireAuth just did to get here.
  useEffect(() => {
    apiFetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setVerifiedUser(data.user));
  }, []);

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

  if (!user) return null;

  return (
    <main className="min-h-screen bg-black text-zinc-100">
      <header className="border-b border-white/10">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold tracking-tight">Dreamer</span>
          </div>
          <button
            onClick={handleLogout}
            disabled={signingOut}
            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold mb-1">Welcome, {user.name}</h1>
        <p className="text-zinc-400 text-sm mb-8">You&apos;re signed in to your Dreamer console.</p>

        <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-6 mb-6">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Account</h2>
          <dl className="grid grid-cols-[120px_1fr] gap-y-3 text-sm">
            <dt className="text-zinc-500">Email</dt>
            <dd className="text-zinc-200">{user.email}</dd>

            <dt className="text-zinc-500">Verified</dt>
            <dd className="flex items-center gap-1.5">
              {user.emailVerified ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="text-zinc-200">Yes</span>
                </>
              ) : (
                <>
                  <CircleDashed className="w-4 h-4 text-zinc-500" />
                  <span className="text-zinc-400">Not verified</span>
                </>
              )}
            </dd>

            <dt className="text-zinc-500">GitHub</dt>
            <dd className="flex items-center gap-1.5">
              {user.githubUsername ? (
                <>
                  <GithubIcon className="w-4 h-4 text-zinc-300" />
                  <span className="text-zinc-200">{user.githubUsername}</span>
                </>
              ) : (
                <span className="text-zinc-500">Not connected</span>
              )}
            </dd>
          </dl>
        </div>

        <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-6 mb-6">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-2">
            Live from GET /api/auth/me
          </h2>
          <p className="text-xs text-zinc-500 mb-3">
            Fetched separately via <code className="text-zinc-400">apiFetch</code> using the in-memory
            access token, to confirm the Bearer-token + <code className="text-zinc-400">requireAuth</code>{" "}
            path works end-to-end from this page, not just the cookie-based refresh that got you here.
          </p>
          <pre className="text-xs text-emerald-300/90 bg-black/40 rounded-lg p-3 overflow-x-auto">
            {verifiedUser ? JSON.stringify(verifiedUser, null, 2) : "loading..."}
          </pre>
        </div>

        <button
          onClick={handleLogoutAll}
          disabled={signingOut}
          className="flex items-center gap-2 text-sm text-zinc-400 hover:text-red-400 transition-colors disabled:opacity-50"
        >
          <Monitor className="w-4 h-4" />
          Sign out of all devices
        </button>
      </div>
    </main>
  );
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardContent />
    </RequireAuth>
  );
}
```

This page deliberately does two independent things that both prove the system works for different
reasons: `RequireAuth` getting you here at all proves the cookie-based silent refresh worked, and
the `GET /api/auth/me` panel proves the in-memory access token + `Authorization` header +
`requireAuth` middleware path *also* works, end to end, from a real component — not just from
`curl`.

---

## 9. Wiring the landing page's "Launch Console" button

The landing page already has two identical "Launch Console" buttons (desktop nav + mobile drawer)
that did nothing. This is the same pattern Vercel and Railway use on their own marketing sites — one
button, smart-routed:

```tsx
const router = useRouter();
const { user, loading } = useAuth();

const goToConsole = () => {
  setMobileMenuOpen(false);
  router.push(loading ? "/login" : user ? "/dashboard" : "/login");
};
```

added near the top of the component, with `onClick={goToConsole}` added to both existing `<button>`
elements (text unchanged — "Launch Console" reads correctly either way, exactly like "Dashboard" vs
"Login" does on the sites this is modeled after).

---

## 10. Testing it

With API running (`npm run dev` in `apps/api-server`) and the frontend pointed at it
(`NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` in `.env`):

```bash
cd apps/frontend
npm run dev
```

Then by hand: visit `/register`, create an account, land on `/dashboard` and see your name plus the
live `GET /api/auth/me` panel. Reload the page — you should stay logged in (that's the silent
refresh working). Sign out, visit `/dashboard` directly — you should bounce to `/login` with no
flash of the dashboard's real content. Click "Continue with GitHub" from `/login` — you should land
on GitHub's real consent screen, then back on `/dashboard`, logged in.

What I verified directly, the same way as the API guide — actually building and running this, not
just reading the code:

- `tsc --noEmit` — clean, no errors.
- `next build` — compiles, type-checks, and statically prerenders all 7 routes (`/`, `/login`,
  `/register`, `/dashboard`, `/auth/callback`, `/demo`, `/_not-found`) successfully.
- `next start` against a mock of your API, hit with `curl`: every route returns `200` with no
  rendered error boundary. `/dashboard` correctly renders only the spinner (never the account
  content) when the mock API reports no session. `/login`'s static HTML now contains the skeleton
  shell instead of nothing, confirming the `Suspense` fallback fix actually took effect.

What I could *not* test in this sandbox (no access to `github.com` or a real Postgres from here):
the actual GitHub consent screen round-trip, and a real login storing a real user row. Everything up
to and immediately after that boundary — the redirect construction, the `state` cookie, the
`/auth/callback` landing logic — is exercised by the above; the live three-way handshake with
GitHub itself you'll see the first time you click the button for real.

---

## 11. Final file list

```
apps/frontend/
├── app/
│   ├── providers.tsx              # rewritten: fixed /api path, unified token state
│   ├── require-auth.tsx           # new: client-side route guard
│   ├── landingpage.tsx            # modified: shared icon import, "Launch Console" wired
│   ├── login/
│   │   └── page.tsx               # new
│   ├── register/
│   │   └── page.tsx               # new
│   ├── auth/
│   │   └── callback/
│   │       └── page.tsx           # new
│   └── dashboard/
│       └── page.tsx               # new
├── components/
│   └── icons.tsx                  # new: shared GithubIcon
└── lib/
    ├── config.ts                  # unchanged
    ├── api-client.ts              # rewritten: pub-sub + .clone() fix
    └── auth.ts                    # new: typed auth API client
```

No `proxy.ts` — and per Section 0, that's not an oversight.
