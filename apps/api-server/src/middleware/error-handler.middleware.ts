import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';

/**
 * Express recognizes this as an error handler purely because it takes 4 args.
 * It must be registered AFTER every route with app.use(errorHandlerMiddleware).
 *
 * Express 5 automatically forwards rejected
 * promises from async route handlers to this middleware — you do not need
 * to wrap every controller in try/catch. Just `throw new SomeAppError(...)`
 * from anywhere in the request lifecycle (service, controller, middleware)
 * and it lands here.
 */
export function errorHandlerMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }

  // Anything that isn't an AppError is a bug, not an expected failure —
  // log it loudly server-side, never leak internals (stack traces, SQL, etc.) to the client.
  console.error('[UNHANDLED ERROR]', err);
  return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}