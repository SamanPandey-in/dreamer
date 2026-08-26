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
 * Keeps AuthProvider's React state in sync with this module's token — a
 * background silent refresh would otherwise update the token without ever
 * notifying the UI.
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
    // .clone(): the body can only be read once, and the caller still needs
    // the original error if this isn't a refreshable case.
    const body = await res
      .clone()
      .json()
      .catch(() => null);

    if (body?.code === "TOKEN_EXPIRED") {
      // Coalesce concurrent refreshes — parallel 401s share one /refresh call.
      refreshPromise ??= refreshAccessToken().finally(() => {
        refreshPromise = null;
      });

      const newToken = await refreshPromise;
      if (newToken) res = await doFetch(newToken);
    }
  }

  return res;
}