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
  verifyEmailHandler,
  resendVerificationHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  githubRedirectHandler,
  githubConnectRedirectHandler,
  githubCallbackHandler,
} from './auth.controller';
import { requireAuth } from './auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  loginRateLimiter,
  registerRateLimiter,
  refreshRateLimiter,
  resendVerificationRateLimiter,
  forgotPasswordRateLimiter,
} from '../middleware/rate-limiter.middleware';
import {
  registerSchema,
  loginSchema,
  changePasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.types';

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

// Email verification / password reset — all public, unauthenticated
authRouter.post('/verify-email', validate(verifyEmailSchema), verifyEmailHandler);
authRouter.post('/resend-verification', resendVerificationRateLimiter, validate(resendVerificationSchema), resendVerificationHandler);
authRouter.post('/forgot-password', forgotPasswordRateLimiter, validate(forgotPasswordSchema), forgotPasswordHandler);
authRouter.post('/reset-password', validate(resetPasswordSchema), resetPasswordHandler);

// GitHub OAuth
authRouter.get('/github', githubRedirectHandler);
authRouter.get('/github/connect', requireAuth, githubConnectRedirectHandler);
authRouter.get('/github/callback', githubCallbackHandler);