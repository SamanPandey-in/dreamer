import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { env } from '../lib/env';
import { UnauthorizedError } from '../lib/errors';
import * as authService from './auth.service';
import {
  buildGithubAuthorizeUrl,
  exchangeCodeForToken,
  fetchGithubProfile,
  fetchPrimaryVerifiedGithubEmail,
} from './github.service';
import type { SessionMeta } from './auth.tokens';

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_PATH = '/api/auth'; // cookie is only ever sent back to auth routes
const OAUTH_STATE_COOKIE_NAME = 'github_oauth_state';
const OAUTH_CALLBACK_PATH = '/api/auth/github/callback';

function sessionMeta(req: Request): SessionMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    // 'strict' is safe here because the frontend and API are assumed to share
    // a parent domain (e.g. app.yourdomain.com / api.yourdomain.com) — SameSite
    // is scoped to the registrable domain, not the exact origin. If you ever
    // deploy them on two unrelated domains, switch to 'none' + secure: true.
    // sameSite: 'strict',
    sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

// Email + password

export async function registerHandler(req: Request, res: Response) {
  const { accessToken, refreshToken, user } = await authService.register(req.body, sessionMeta(req));
  setRefreshCookie(res, refreshToken);
  res.status(201).json({ accessToken, user });
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

// GitHub OAuth

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

/** GET /api/auth/github/callback — GitHub redirects here after the user approves/denies. */
export async function githubCallbackHandler(req: Request, res: Response) {
  const { code, state } = req.query as { code?: string; state?: string };
  const cookieState = req.cookies?.[OAUTH_STATE_COOKIE_NAME];

  res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: OAUTH_CALLBACK_PATH });

  if (!code || !state || !cookieState || state !== cookieState) {
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_state_mismatch`);
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
    console.error('[GITHUB_OAUTH_ERROR]', err);
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_auth_failed`);
  }
}