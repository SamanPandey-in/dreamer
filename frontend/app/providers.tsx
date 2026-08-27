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
  /**
   * True once GET /api/auth/setup-status has actually returned (as opposed to
   * `false` because it hasn't loaded yet) — distinguishes "haven't checked"
   * from "checked: not set up" before redirecting to /setup.
   */
  setupStatusLoaded: boolean;
  /** Whether the one-time admin account has already been created. See docs/architecture/local-engine-auth-and-networking.md Decision 1. */
  setupComplete: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** Creates the single admin account AND logs them in — only ever succeeds once. */
  setup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-fetches the current user — used after an in-place account change (e.g. setting/clearing the git PAT) that doesn't go through login/setup. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function getSessionUser(): Promise<AuthUser | null> {
  try {
    const data = await authApi.refresh();
    return data.user;
  } catch {
    return null;
  }
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <Providers>");
  return ctx;
}

export function Providers({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessTokenState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupComplete, setSetupComplete] = useState(false);
  const [setupStatusLoaded, setSetupStatusLoaded] = useState(false);

  // api-client.ts owns the in-memory access token (apiFetch reads it from
  // there on every request); mirror its changes into state so re-renders
  // track silent background refreshes too, not just calls made here.
  useEffect(() => onAccessTokenChange(setAccessTokenState), []);

  // First load: restore the session from the httpOnly refresh cookie AND
  // check whether an admin exists yet — in parallel, neither depends on the
  // other. Keeps logins alive across reloads without localStorage and routes
  // fresh installs to /setup instead of a login form with no account.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getSessionUser(),
      authApi
        .getSetupStatus()
        .then((status) => status.complete)
        .catch((): boolean | null => {
          // Not fatal — leave setupStatusLoaded false so callers keep waiting
          // rather than wrongly assuming either answer.
          return null;
        }),
    ])
      .then(([sessionUser, setupCompleteResult]) => {
        if (cancelled) return;
        setUser(sessionUser);
        if (setupCompleteResult !== null) {
          setSetupComplete(setupCompleteResult);
          setSetupStatusLoaded(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await authApi.login(email, password);
    setUser(data.user);
  }, []);

  const setup = useCallback(async (name: string, email: string, password: string) => {
    const data = await authApi.setup(name, email, password);
    setUser(data.user);
    setSetupComplete(true);
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setClientAccessToken(null);
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    const freshUser = await authApi.getMe();
    setUser(freshUser);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        loading,
        setupStatusLoaded,
        setupComplete,
        login,
        setup,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
