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