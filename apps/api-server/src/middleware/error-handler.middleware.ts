import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

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
  // requestId is also already on the X-Request-Id response header
  // (request-context.middleware.ts sets it before any route runs), but
  // repeating it in the body means a frontend catch block that only has
  // the parsed JSON — not the raw Response — can still show it to the user
  // as a support reference, and it survives getting copy-pasted into a bug report.
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      // A 5xx AppError (rare, but e.g. QUEUE_ENQUEUE_FAILED-adjacent cases)
      // is still worth the full error-level log a bug gets, not just an info line.
      logger.error(err.message, { code: err.code, statusCode: err.statusCode, path: req.path, err });
    } else {
      // 4xx AppErrors are expected, routine control flow (a bad request, a
      // 404, a conflict) — logging them at 'info' keeps error-level logs
      // meaning "something actually broke," which is what makes them worth
      // alerting on later.
      logger.info(err.message, { code: err.code, statusCode: err.statusCode, path: req.path });
    }
    return res.status(err.statusCode).json({ error: err.message, code: err.code, requestId: req.id });
  }

  // Anything that isn't an AppError is a bug, not an expected failure —
  // log it loudly server-side with the full stack, never leak internals
  // (stack traces, SQL, etc.) to the client.
  logger.error('Unhandled error', { path: req.path, err });
  return res
    .status(500)
    .json({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId: req.id });
}