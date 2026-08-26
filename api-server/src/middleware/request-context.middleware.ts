import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { runWithContext } from '../lib/logger';

const REQUEST_ID_HEADER = 'x-request-id';
// A caller-supplied request ID is only trusted if it looks like this —
// otherwise a client could inject arbitrary text into every log line for
// that request. UUIDs (ours) and short opaque tokens both match.
const VALID_REQUEST_ID = /^[a-zA-Z0-9._-]{1,100}$/;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Echoed back as X-Request-Id and attached to every log line and error response for this request. */
      id: string;
    }
  }
}

/**
 * Mounted first in app.ts, before every route. This is what makes
 * "correlation ID in every log line" true for the WHOLE request — not just
 * the top-level controller, but every service/prisma-adjacent log several
 * layers deep, since they all read the same AsyncLocalStorage context this
 * sets up via logger.ts's runWithContext.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId =
    typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();

  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  runWithContext({ correlationId: requestId, source: 'http' }, () => next());
}