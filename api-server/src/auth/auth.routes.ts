import { Router } from 'express';
import {
  setupHandler,
  setupStatusHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  logoutAllHandler,
  meHandler,
  listSessionsHandler,
  revokeSessionHandler,
  changePasswordHandler,
  setGitTokenHandler,
  clearGitTokenHandler,
} from './auth.controller';
import { requireAuth } from './auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  loginRateLimiter,
  setupRateLimiter,
  refreshRateLimiter,
} from '../middleware/rate-limiter.middleware';
import {
  setupSchema,
  loginSchema,
  changePasswordSchema,
  setGitTokenSchema,
} from './auth.types';

export const authRouter = Router();

// local-engine: single-admin setup instead of open registration — see
// docs/architecture/local-engine-auth-and-networking.md Decision 1.
authRouter.get('/setup-status', setupStatusHandler);
authRouter.post('/setup', setupRateLimiter, validate(setupSchema), setupHandler);

authRouter.post('/login', loginRateLimiter, validate(loginSchema), loginHandler);
authRouter.post('/refresh', refreshRateLimiter, refreshHandler);
authRouter.post('/logout', logoutHandler);
authRouter.post('/logout-all', requireAuth, logoutAllHandler);
authRouter.get('/me', requireAuth, meHandler);

// Sessions & password
authRouter.get('/sessions', requireAuth, listSessionsHandler);
authRouter.delete('/sessions/:sessionId', requireAuth, revokeSessionHandler);
authRouter.post('/change-password', requireAuth, validate(changePasswordSchema), changePasswordHandler);

// Git PAT (Settings page) — see
// docs/architecture/local-engine-auth-and-networking.md Decision 2.
authRouter.put('/git-token', requireAuth, validate(setGitTokenSchema), setGitTokenHandler);
authRouter.delete('/git-token', requireAuth, clearGitTokenHandler);
