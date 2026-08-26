import { API_BASE_URL } from "./config";
import { apiFetch, setAccessToken } from "./api-client";
import { ApiError, extractRequestId } from "./api-error";

// Mirrors PublicUser from the API's src/auth/auth.types.ts — keep these in sync.
// local-engine: see docs/architecture/local-engine-auth-and-networking.md
// Decision 1 & 2 — no githubUsername/emailVerified anymore (no GitHub
// login, no email verification for a single admin); hasGitToken replaces
// them, reflecting the stored PAT instead.
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  hasGitToken: boolean;
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

/**
 * GET /api/auth/setup-status — unauthenticated, safe to call before any
 * login attempt. Drives whether the app shows the one-time setup wizard
 * or the normal login screen. See
 * docs/architecture/local-engine-auth-and-networking.md Decision 1.
 */
export async function getSetupStatus(): Promise<{ complete: boolean }> {
  const res = await fetch(`${API_BASE_URL}/api/auth/setup-status`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? "Failed to check setup status.", data?.code, extractRequestId(data, res));
  return data as { complete: boolean };
}

/**
 * POST /api/auth/setup — creates the single admin account. Only ever
 * succeeds once: the server 409s permanently after the first call
 * succeeds, so the setup wizard should never be shown again after this
 * resolves. Logs the new admin in immediately (unlike the old register(),
 * there's no email-verification gap to wait through).
 */
export async function setup(name: string, email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE_URL}/api/auth/setup`, {
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
 * Exchanges the httpOnly refresh cookie for a fresh access token. Called
 * on every app boot, to restore a session silently.
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

export async function getMe(): Promise<AuthUser> {
  const res = await apiFetch("/api/auth/me");
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? "Failed to load account.", data?.code, extractRequestId(data, res));
  return data.user as AuthUser;
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

// Git PAT (Settings > Git) — see
// docs/architecture/local-engine-auth-and-networking.md Decision 2. The
// token itself is write-only from the client's perspective: AuthUser only
// ever reports hasGitToken (a boolean), never the token, so there's
// nothing to prefill an input with — Settings should show a masked
// placeholder plus "Update"/"Remove" affordances instead of an editable
// current value.

export async function setGitToken(personalAccessToken: string): Promise<void> {
  const res = await apiFetch("/api/auth/git-token", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ personalAccessToken }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? "Failed to save git token.", data?.code, extractRequestId(data, res));
  }
}

export async function clearGitToken(): Promise<void> {
  const res = await apiFetch("/api/auth/git-token", { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? "Failed to remove git token.", data?.code, extractRequestId(data, res));
  }
}
