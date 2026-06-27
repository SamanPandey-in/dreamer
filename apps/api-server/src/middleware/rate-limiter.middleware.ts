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
export const loginRateLimiter = createRateLimiter(15, 10); // 10 attempts / 15 min / IP
export const registerRateLimiter = createRateLimiter(60, 5); // 5 signups / hour / IP
export const refreshRateLimiter = createRateLimiter(15, 30); // refresh fires often — give it room

//  NEW — reveal returns a real plaintext secret, not just a yes/no. 20 per
// 15 minutes per IP is generous enough for someone clicking through several
// vars on the env page in one sitting, tight enough to blunt a scripted
// "reveal everything on this project" sweep run against a stolen session.
export const revealEnvVariableRateLimiter = createRateLimiter(15, 20);