import { API_BASE_URL } from "./config";
import { apiFetch, setAccessToken } from "./api-client";
import { ApiError, extractRequestId } from "./api-error";

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
    throw new ApiError(data?.error ?? "Something went wrong. Please try again.", data?.code, extractRequestId(data, res));
  }

  return data as AuthResponse;
}

// Registering no longer logs the user in — the account needs email
// verification first, so there's no accessToken to receive.
export async function register(name: string, email: string, password: string): Promise<{ user: AuthUser }> {
  const res = await fetch(`${API_BASE_URL}/api/auth/register`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(data?.error ?? "Something went wrong. Please try again.", data?.code, extractRequestId(data, res));
  }
  return data as { user: AuthUser };
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

/**
 * Kicks off the "Connect GitHub" flow for an already-logged-in user
 * (Settings, New Project wizard) — distinct from githubLoginUrl() above,
 * which is for the logged-out login/register screens where a plain
 * `<a href>` works fine. This one goes through apiFetch specifically
 * because the backend route is behind requireAuth, which needs the access
 * token as a real `Authorization` header — something only a fetch call can
 * attach, not a browser navigation. Returns the GitHub authorize URL to
 * navigate to (e.g. `window.location.href = url`), or throws if not signed
 * in / the request fails.
 * `returnTo` is resolved against a fixed allowlist server-side, not taken
 * as a raw path, so it can only ever be one of those two short codes.
 */
export async function connectGithub(returnTo: "account" | "project"): Promise<string> {
  const res = await apiFetch(`/api/auth/github/connect?returnTo=${returnTo}`);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? "Failed to start GitHub connect.", data?.code, extractRequestId(data, res));
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}

// Mirrors PublicSession from the API's src/auth/auth.types.ts.
export interface AuthSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  lastUsedAt: string;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export async function listSessions(): Promise<AuthSession[]> {
  const res = await apiFetch("/api/auth/sessions");
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? "Failed to load sessions.", data?.code, extractRequestId(data, res));
  return data.sessions;
}

export async function revokeSession(sessionId: string): Promise<void> {
  const res = await apiFetch(`/api/auth/sessions/${sessionId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? "Failed to revoke session.", data?.code, extractRequestId(data, res));
  }
}

export interface ChangePasswordInput {
  currentPassword?: string;
  newPassword: string;
}

export async function changePassword(input: ChangePasswordInput): Promise<void> {
  const res = await apiFetch("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? "Failed to change password.", data?.code, extractRequestId(data, res));
  }
}

// Email verification / password reset — all public, unauthenticated (plain
// fetch, not apiFetch, since there's no access token yet at this point).

async function publicPost(path: string, body: unknown, fallback: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? fallback, data?.code, extractRequestId(data, res));
  }
}

export function verifyEmail(token: string): Promise<void> {
  return publicPost("/api/auth/verify-email", { token }, "This verification link is invalid or has expired.");
}

export function resendVerification(email: string): Promise<void> {
  return publicPost("/api/auth/resend-verification", { email }, "Failed to resend verification email.");
}

export function forgotPassword(email: string): Promise<void> {
  return publicPost("/api/auth/forgot-password", { email }, "Failed to send reset email.");
}

export function resetPassword(token: string, newPassword: string): Promise<void> {
  return publicPost("/api/auth/reset-password", { token, newPassword }, "This reset link is invalid or has expired.");
}