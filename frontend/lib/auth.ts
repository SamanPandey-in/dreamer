import { API_BASE_URL } from "./config";
import { apiFetch, setAccessToken } from "./api-client";
import { ApiError, extractRequestId } from "./api-error";

// Mirrors PublicUser in api-server/src/auth/auth.types.ts — keep in sync.
// Single-admin setup: no GitHub login or email verification; hasGitToken
// reflects the stored PAT instead (see
// docs/architecture/local-engine-auth-and-networking.md).
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
 * or the normal login screen.
 */
export async function getSetupStatus(): Promise<{ complete: boolean }> {
  const res = await fetch(`${API_BASE_URL}/api/auth/setup-status`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? "Failed to check setup status.", data?.code, extractRequestId(data, res));
  return data as { complete: boolean };
}

/**
 * POST /api/auth/setup — creates the single admin account. Only ever
 * succeeds once (the server permanently 409s after the first success),
 * so never resurface the setup wizard after this resolves. Logs the new
 * admin in immediately.
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

// Git PAT (Settings > Git) — write-only from the client's perspective:
// AuthUser only ever reports hasGitToken, never the token, so there's
// nothing to prefill an input with — Settings shows a masked placeholder
// plus "Update"/"Remove" affordances rather than an editable current value.

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
