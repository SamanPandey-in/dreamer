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
   * True once GET /api/auth/setup-status has actually returned (as
   * opposed to `false` because it hasn't loaded yet). Distinguishes
   * "haven't checked" from "checked: not set up" for callers deciding
   * whether to redirect to /setup — see app/setup/page.tsx.
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

  // On first load: check setup status (do we even have an admin yet?) AND
  // try to turn an existing httpOnly refresh cookie into a fresh access
  // token — run together, not sequentially, since neither depends on the
  // other's result. This is what keeps someone logged in across a page
  // reload without ever putting a token in localStorage, and what lets the
  // app route a fresh install straight to /setup instead of a login form
  // that has no account to log into yet.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      refreshSession(),
      authApi
        .getSetupStatus()
        .then((status) => {
          if (!cancelled) {
            setSetupComplete(status.complete);
            setSetupStatusLoaded(true);
          }
        })
        .catch(() => {
          // Setup-status check failing (network blip, API not up yet) isn't
          // fatal — leave setupStatusLoaded false so callers keep waiting
          // rather than wrongly assuming setup is or isn't done.
        }),
    ]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshSession]);

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
