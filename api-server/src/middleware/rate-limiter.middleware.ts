import rateLimit from 'express-rate-limit';

/** Factory so every route can tune its own window/max independently. */
function createRateLimiter(windowMinutes: number, max: number) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true, // sends RateLimit-* response headers
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
  });
}

// Tight limits on the most abuse-prone auth endpoints — blunt brute-force
// without blocking legitimate users.
export const loginRateLimiter = createRateLimiter(15, 30); // 30 attempts / 15 min / IP
// Setup only ever succeeds once (see auth.service.ts's setupAdmin) — this
// just blunts scripts hammering the endpoint after it's already 409ing.
export const setupRateLimiter = createRateLimiter(60, 15);
export const refreshRateLimiter = createRateLimiter(15, 90); // refresh fires often — give it room

// Reveal returns a real plaintext secret, so bounded-but-usable: enough for
// clicking through several vars in one sitting, tight enough to blunt a
// scripted reveal-everything sweep against a stolen session.
export const revealEnvVariableRateLimiter = createRateLimiter(15, 60);