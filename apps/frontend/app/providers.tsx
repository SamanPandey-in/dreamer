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
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refreshSession calls setUser synchronously inside async body; deferring causes login flash
    refreshSession().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
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
