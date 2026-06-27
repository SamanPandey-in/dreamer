import { Router } from 'express';
import {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  logoutAllHandler,
  meHandler,
  listSessionsHandler,
  revokeSessionHandler,
  changePasswordHandler,
  githubRedirectHandler,
  githubCallbackHandler,
} from './auth.controller';
import { requireAuth } from './auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  loginRateLimiter,
  registerRateLimiter,
  refreshRateLimiter,
} from '../middleware/rate-limiter.middleware';
import { registerSchema, loginSchema, changePasswordSchema } from './auth.types';

export const authRouter = Router();

// Email + password
authRouter.post('/register', registerRateLimiter, validate(registerSchema), registerHandler);
authRouter.post('/login', loginRateLimiter, validate(loginSchema), loginHandler);
authRouter.post('/refresh', refreshRateLimiter, refreshHandler);
authRouter.post('/logout', logoutHandler);
authRouter.post('/logout-all', requireAuth, logoutAllHandler);
authRouter.get('/me', requireAuth, meHandler);

// Sessions & password
authRouter.get('/sessions', requireAuth, listSessionsHandler);
authRouter.delete('/sessions/:sessionId', requireAuth, revokeSessionHandler);
authRouter.post('/change-password', requireAuth, validate(changePasswordSchema), changePasswordHandler);

// GitHub OAuth
authRouter.get('/github', githubRedirectHandler);
authRouter.get('/github/callback', githubCallbackHandler);