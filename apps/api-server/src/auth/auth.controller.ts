import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { UnauthorizedError } from '../lib/errors';
import * as authService from './auth.service';
import {
  buildGithubAuthorizeUrl,
  exchangeCodeForToken,
  fetchGithubProfile,
  fetchPrimaryVerifiedGithubEmail,
} from './github.service';
import { signGithubConnectState, verifyGithubConnectState, type SessionMeta } from './auth.tokens';

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_PATH = '/api/auth'; // cookie is only ever sent back to auth routes
const OAUTH_STATE_COOKIE_NAME = 'github_oauth_state';
const OAUTH_CALLBACK_PATH = '/api/auth/github/callback';

function sessionMeta(req: Request): SessionMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

// Derive cross-origin from FRONTEND_URL rather than NODE_ENV so the cookie
// settings are correct even if NODE_ENV isn't set to 'production' on the host.
// On localhost the frontend and API share a site (SameSite=Lax works); on
// different domains (e.g. Vercel + Render) we need SameSite=None + Secure.
function isSecureContext(): boolean {
  const hostname = new URL(env.FRONTEND_URL).hostname;
  return hostname !== 'localhost' && hostname !== '127.0.0.1';
}

const COOKIE_SAME_SITE = () => isSecureContext() ? 'none' as const : 'lax' as const;
const COOKIE_SECURE   = () => isSecureContext();

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE(),
    sameSite: COOKIE_SAME_SITE(),
    path: REFRESH_COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    path: REFRESH_COOKIE_PATH,
    secure: COOKIE_SECURE(),
    sameSite: COOKIE_SAME_SITE(),
  });
}

// Email + password

export async function registerHandler(req: Request, res: Response) {
  // No accessToken/refreshCookie anymore — the account exists but can't log
  // in until the verification email is clicked. See auth.service.ts.
  const { user } = await authService.register(req.body, sessionMeta(req));
  res.status(201).json({ user });
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

// Email verification / password reset

export async function verifyEmailHandler(req: Request, res: Response) {
  await authService.verifyEmail(req.body, sessionMeta(req));
  res.status(204).send();
}

// Always the same 204, whether or not the email exists / already has a
// password / is already verified — see resendVerification()'s comment.
export async function resendVerificationHandler(req: Request, res: Response) {
  await authService.resendVerification(req.body, sessionMeta(req));
  res.status(204).send();
}

// Always the same 204 — see requestPasswordReset()'s comment.
export async function forgotPasswordHandler(req: Request, res: Response) {
  await authService.requestPasswordReset(req.body, sessionMeta(req));
  res.status(204).send();
}

export async function resetPasswordHandler(req: Request, res: Response) {
  await authService.resetPassword(req.body, sessionMeta(req));
  res.status(204).send();
}

// GitHub OAuth

// Only these two relative paths are ever redirected to after a connect —
// resolved server-side from a short code, never taken as a raw path from
// the query string, so this can't be turned into an open redirect.
const GITHUB_CONNECT_RETURN_TARGETS: Record<string, string> = {
  account: '/dashboard/account',
  project: '/dashboard/new',
};
const DEFAULT_GITHUB_CONNECT_RETURN = GITHUB_CONNECT_RETURN_TARGETS.account;

/** GET /api/auth/github — redirects the browser to GitHub's consent screen. */
export function githubRedirectHandler(req: Request, res: Response) {
  const state = crypto.randomBytes(16).toString('hex');

  // Short-lived, httpOnly. 'lax' (not 'strict') because GitHub's redirect
  // back to our callback is a cross-site TOP-LEVEL navigation — a 'strict'
  // cookie would not be sent on that request, breaking the CSRF check below.
  res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: OAUTH_CALLBACK_PATH,
  });

  res.redirect(buildGithubAuthorizeUrl(state));
}

/**
 * GET /api/auth/github/connect — same OAuth dance as githubRedirectHandler,
 * but for an already-logged-in user linking GitHub to their existing
 * email/password account, from Settings or the New Project wizard.
 *
 * Unlike githubRedirectHandler, this one returns JSON instead of
 * redirecting: it's behind requireAuth, which only ever sees the access
 * token on a request carrying an `Authorization: Bearer` header — a plain
 * `<a href>` navigation to GitHub can't attach one. So the frontend calls
 * this via apiFetch (which does attach it) to get the authorize URL, then
 * does the actual top-level navigation itself. The `state` this mints is a
 * signed JWT embedding the caller's userId (see auth.tokens.ts), not a bare
 * random string, so githubCallbackHandler below can tell this flow apart
 * from a fresh login/register.
 */
export function githubConnectRedirectHandler(req: Request, res: Response) {
  const requestedReturnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined;
  const returnTo = (requestedReturnTo && GITHUB_CONNECT_RETURN_TARGETS[requestedReturnTo]) || DEFAULT_GITHUB_CONNECT_RETURN;

  const state = signGithubConnectState(req.user!.id, returnTo);

  // Set via a fetch() response (credentials: 'include' on the frontend's
  // apiFetch call) rather than a redirect — still a normal Set-Cookie the
  // browser stores, still read back by githubCallbackHandler after GitHub's
  // own redirect lands there directly (a real top-level navigation).
  res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: OAUTH_CALLBACK_PATH,
  });

  res.status(200).json({ url: buildGithubAuthorizeUrl(state) });
}

/** GET /api/auth/github/callback — GitHub redirects here after the user approves/denies. */
export async function githubCallbackHandler(req: Request, res: Response) {
  const { code, state } = req.query as { code?: string; state?: string };
  const cookieState = req.cookies?.[OAUTH_STATE_COOKIE_NAME];

  res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: OAUTH_CALLBACK_PATH });

  if (!code || !state || !cookieState || state !== cookieState) {
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_state_mismatch`);
  }

  // A connect-state verifies successfully only for a state signed by
  // githubConnectRedirectHandler above — a normal login's random-hex state
  // simply isn't valid JWT input, so this returns null and falls through
  // to the existing login/register flow unchanged.
  const connectState = verifyGithubConnectState(state);

  if (connectState) {
    try {
      const githubAccessToken = await exchangeCodeForToken(code);
      const profile = await fetchGithubProfile(githubAccessToken);
      const verifiedEmail = await fetchPrimaryVerifiedGithubEmail(githubAccessToken);

      await authService.connectGithubAccount(
        connectState.userId,
        { profile, verifiedEmail, githubAccessToken },
        sessionMeta(req)
      );

      return res.redirect(`${env.FRONTEND_URL}${connectState.returnTo}?github=connected`);
    } catch (err) {
      // GITHUB_ALREADY_LINKED is an expected, user-facing outcome (someone
      // else already connected that GitHub account) — surface its code
      // specifically so the frontend can show the right message instead of
      // a generic failure.
      const errCode = err instanceof Error && 'code' in err ? (err as { code: string }).code : undefined;
      logger.error('GitHub connect callback failed', { err });
      return res.redirect(
        `${env.FRONTEND_URL}${connectState.returnTo}?error=${errCode === 'GITHUB_ALREADY_LINKED' ? 'github_already_linked' : 'github_connect_failed'}`
      );
    }
  }

  try {
    const githubAccessToken = await exchangeCodeForToken(code);
    const profile = await fetchGithubProfile(githubAccessToken);
    const verifiedEmail = await fetchPrimaryVerifiedGithubEmail(githubAccessToken);

    const { refreshToken } = await authService.loginOrRegisterWithGithub({
      profile,
      verifiedEmail,
      githubAccessToken,
      meta: sessionMeta(req),
    });

    setRefreshCookie(res, refreshToken);

    // We deliberately do NOT put the access token in this redirect URL — URLs
    // end up in browser history and server access logs. The frontend lands on
    // /auth/callback and immediately calls POST /auth/refresh, which reads the
    // httpOnly cookie we just set and returns a fresh access token straight
    // into memory.
    return res.redirect(`${env.FRONTEND_URL}/auth/callback`);
  } catch (err) {
    logger.error('GitHub OAuth callback failed', { err });
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_auth_failed`);
  }
}