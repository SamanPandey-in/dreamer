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

// Tight limits on the most abuse-prone auth endpoints — blunt enough to stop
// naive brute-force / credential-stuffing scripts without needing a WAF.
// RAISED — the previous ceilings were tight enough to be hit by a single
// legitimate user during normal use (a few mistyped passwords, a page
// refreshed a few times), not just by an abuse script. Values below are
// roughly 3x the old ones; still bounded, just less trigger-happy.
export const loginRateLimiter = createRateLimiter(15, 30); // 30 attempts / 15 min / IP
// local-engine: only ever fires successfully once (see auth.service.ts's
// setupAdmin) — this limiter just blunts a script hammering the endpoint
// after it's already 409ing.
export const setupRateLimiter = createRateLimiter(60, 15);
export const refreshRateLimiter = createRateLimiter(15, 90); // refresh fires often — give it room

//  NEW — reveal returns a real plaintext secret, not just a yes/no. Raised
// from 20 to 60 per 15 minutes per IP — generous enough for someone
// clicking through several vars on the env page in one sitting, tight
// enough to blunt a scripted "reveal everything on this project" sweep run
// against a stolen session.
export const revealEnvVariableRateLimiter = createRateLimiter(15, 60);