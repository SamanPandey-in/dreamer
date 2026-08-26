import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { verifyAccessToken } from './auth.tokens';
import { UnauthorizedError } from '../lib/errors';

/**
 * Protects a route — requires a valid `Authorization: Bearer <accessToken>` header.
 * On success, attaches { id, email } to req.user for downstream handlers.
 *
 * The TOKEN_EXPIRED code is distinct from INVALID_TOKEN on purpose: the
 * frontend's fetch/axios interceptor checks for exactly this code to decide
 * whether it's safe to attempt a silent refresh, vs. redirecting straight to
 * /login for a token that's simply garbage.
 */

// TOKEN_EXPIRED -> then we refresh the token and retry the request
// INVALID_TOKEN -> then we redirect to login
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing or malformed Authorization header', 'NO_TOKEN'));
  }

  const token = header.slice('Bearer '.length);

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new UnauthorizedError('Access token expired', 'TOKEN_EXPIRED'));
    }
    return next(new UnauthorizedError('Invalid access token', 'INVALID_TOKEN'));
  }
}