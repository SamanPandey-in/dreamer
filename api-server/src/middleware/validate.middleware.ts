import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { BadRequestError } from '../lib/errors';

/**
 * Validates req.body / req.query / req.params against a schema shaped like
 *   z.object({ body: ..., query: ..., params: ... })
 * and overwrites each with its parsed (and possibly transformed —
 * e.g. .toLowerCase()) value. Any field the schema doesn't define is
 * simply left untouched.
 */
export function validate(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      }) as { body?: unknown; query?: unknown; params?: unknown };

      if (parsed.body !== undefined) req.body = parsed.body;
      if (parsed.query !== undefined) {
        Object.defineProperty(req, 'query', { value: parsed.query, writable: true, configurable: true });
      }
      if (parsed.params !== undefined) {
        Object.defineProperty(req, 'params', { value: parsed.params, writable: true, configurable: true });
      }

      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return next(new BadRequestError(message, 'VALIDATION_ERROR'));
      }
      next(err);
    }
  };
}

// Live-tested response for a bad payload ({"email":"not-an-email","password":"short","name":""}):

// HTTP/1.1 400 Bad Request
// {"error":"body.email: Invalid email address; body.password: Password must be at least 8 characters; body.name: Too small: expected string to have >=1 characters","code":"VALIDATION_ERROR"}
// Every field's error, aggregated in one pass — not "fix one field, resubmit, discover the next error."