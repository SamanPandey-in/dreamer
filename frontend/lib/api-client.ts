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