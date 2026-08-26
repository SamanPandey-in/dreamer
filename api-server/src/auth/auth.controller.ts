import type { Request, Response } from 'express';
import { env } from '../lib/env';
import { UnauthorizedError } from '../lib/errors';
import * as authService from './auth.service';
import type { SessionMeta } from './auth.tokens';

export const REFRESH_COOKIE_NAME = 'refreshToken';
export const REFRESH_COOKIE_PATH = '/api';

function sessionMeta(req: Request): SessionMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

// Derive cross-site-ness from FRONTEND_URL vs COOKIE_DOMAIN rather than
// NODE_ENV, so the cookie settings are correct even if NODE_ENV isn't set
// to 'production' on the host. local-engine's dashboard is loopback-only
// (see docs/architecture/local-engine-auth-and-networking.md Decision 4),
// so in the default install this is always the "local dev" case below —
// COOKIE_DOMAIN only matters if an operator deliberately exposes the
// dashboard on a real hostname later.
function isLocalDev(): boolean {
  const hostname = new URL(env.FRONTEND_URL).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

const COOKIE_DOMAIN_ATTR = env.COOKIE_DOMAIN;
const COOKIE_SAME_SITE = () => (isLocalDev() || COOKIE_DOMAIN_ATTR ? 'lax' as const : 'none' as const);
const COOKIE_SECURE = () => !isLocalDev();

export function crossSiteCookieOptions() {
  return {
    secure: COOKIE_SECURE(),
    sameSite: COOKIE_SAME_SITE(),
    ...(COOKIE_DOMAIN_ATTR ? { domain: COOKIE_DOMAIN_ATTR } : {}),
  };
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    ...crossSiteCookieOptions(),
    path: REFRESH_COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    path: REFRESH_COOKIE_PATH,
    ...crossSiteCookieOptions(),
  });
}

// Setup + login

/**
 * POST /api/auth/setup — local-engine's one-time admin creation. See
 * docs/architecture/local-engine-auth-and-networking.md Decision 1 and
 * auth.service.ts#setupAdmin's doc comment: this permanently 409s the
 * instant one user exists, same shape as Coolify/CapRover's first-run
 * screen.
 */
export async function setupHandler(req: Request, res: Response) {
  const { accessToken, refreshToken, user } = await authService.setupAdmin(req.body, sessionMeta(req));
  setRefreshCookie(res, refreshToken);
  res.status(201).json({ accessToken, user });
}

/** GET /api/auth/setup-status — unauthenticated: lets the frontend decide whether to show the setup wizard or the login page. */
export async function setupStatusHandler(_req: Request, res: Response) {
  const complete = await authService.isSetupComplete();
  res.status(200).json({ complete });
}

export async function loginHandler(req: Request, res: Response) {
  const { accessToken, refreshToken, user } = await authService.login(req.body, sessionMeta(req));
  setRefreshCookie(res, refreshToken);
  res.status(200).json({ accessToken, user });
}

export async function refreshHandler(req: Request, res: Response) {
  const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!rawToken) throw new UnauthorizedError('No refresh token provided', 'NO_REFRESH_TOKEN');

  const { accessToken, refreshToken, user } = await authService.refresh(rawToken, sessionMeta(req));
  setRefreshCookie(res, refreshToken);
  res.status(200).json({ accessToken, user });
}

export async function logoutHandler(req: Request, res: Response) {
  const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
  await authService.logout(rawToken);
  clearRefreshCookie(res);
  res.status(204).send();
}

export async function logoutAllHandler(req: Request, res: Response) {
  await authService.logoutAll(req.user!.id, sessionMeta(req));
  clearRefreshCookie(res);
  res.status(204).send();
}

export async function meHandler(req: Request, res: Response) {
  const user = await authService.getMe(req.user!.id);
  res.status(200).json({ user });
}

// Sessions & password management

function extractSessionIdFromRefreshCookie(req: Request): string | undefined {
  const raw = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!raw) return undefined;
  const dotIndex = raw.indexOf('.');
  return dotIndex > 0 ? raw.slice(0, dotIndex) : undefined;
}

export async function listSessionsHandler(req: Request, res: Response) {
  const currentSessionId = extractSessionIdFromRefreshCookie(req);
  const sessions = await authService.listSessions(req.user!.id, currentSessionId);
  res.status(200).json({ sessions });
}

export async function revokeSessionHandler(req: Request, res: Response) {
  const sessionId = req.params.sessionId as string;
  await authService.revokeSessionByIdForUser(req.user!.id, sessionId, sessionMeta(req));
  res.status(204).send();
}

export async function changePasswordHandler(req: Request, res: Response) {
  await authService.changePassword(req.user!.id, req.body, sessionMeta(req));
  res.status(204).send();
}

// Git PAT (Settings page) — see
// docs/architecture/local-engine-auth-and-networking.md Decision 2.

export async function setGitTokenHandler(req: Request, res: Response) {
  await authService.setGitToken(req.user!.id, req.body.personalAccessToken, sessionMeta(req));
  res.status(204).send();
}

export async function clearGitTokenHandler(req: Request, res: Response) {
  await authService.clearGitToken(req.user!.id, sessionMeta(req));
  res.status(204).send();
}
