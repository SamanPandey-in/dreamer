# Authentication

Dreamer supports two ways to sign in — email/password, and "Continue with
GitHub" — that converge on the same session system underneath. This page
covers both, plus the token/session model both of them produce.

## Two token types, two different jobs

| | Access token | Refresh token |
|---|---|---|
| Format | Signed JWT (HS256) | `{sessionId}.{secret}`, opaque to the client |
| Lifetime | 15 minutes (`ACCESS_TOKEN_TTL`) | 7 days (`REFRESH_TOKEN_TTL_DAYS`) |
| Where it lives | In memory on the frontend, sent as `Authorization: Bearer` | An `httpOnly` cookie, scoped to `/api/auth` only |
| Stored server-side? | No — verifying it is just a signature check | Yes — one `UserSession` row per device |
| What it's for | Authorizing every normal API request | Getting a new access token when the old one expires |

The split exists because these two things want opposite properties. An
access token needs to be checked on *every single request* without
hitting the database — so it's stateless, a pure signature verification.
A refresh token needs to be **revocable** ("sign out this one device,"
"sign out everywhere after a password change") — which a stateless JWT
fundamentally can't do without a separate blocklist, so it's backed by a
real database row instead.

### How a refresh token is actually stored

The raw token handed to the browser is `{sessionId}.{secret}` — but only
`bcrypt(secret)` is ever written to `UserSession.tokenHash`, never the
secret itself. This means a database leak alone doesn't hand out working
sessions — comparing a presented token requires knowing the raw secret
too, which is why the `sessionId` prefix matters: it lets `/refresh` do
one indexed lookup by ID and then bcrypt-compare against exactly that one
row, instead of bcrypt-comparing against every session in the table
(bcrypt is deliberately slow — that's fine for one comparison per
request, not for N).

### Rotation, on every refresh

`POST /api/auth/refresh` doesn't just issue a new access token — it
**deletes** the old session row and creates a brand new one, atomically.
The refresh token in the cookie you just used is now permanently invalid,
even if a copy of it leaked. This is what makes stealing a refresh token
a race against the legitimate user's own next page load, not a
standing, indefinite backdoor.

## Email + password

Standard shape — `POST /register`, `POST /login` — with two details
worth understanding:

**Constant-time login, on purpose.** `login()` runs a bcrypt comparison
*unconditionally*, even when the email doesn't exist in the database at
all:

```ts
const isValid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
```

Without this, a request for a non-existent email returns measurably
faster than one for a real email with a wrong password (no bcrypt call
happened at all) — a timing side-channel that lets an attacker enumerate
which emails have accounts, purely from response latency. Running the
same expensive comparison against a hash of a string that will never be
a real password closes that gap.

**Passwords are capped at 72 characters** — not an arbitrary product
decision, bcrypt silently truncates anything beyond 72 *bytes* and
processes the rest as if it weren't there. The validation schema enforces
this explicitly rather than letting a user set a 200-character password
that bcrypt quietly treats as its first 72 characters.

## GitHub OAuth

```
1. GET /api/auth/github
      → generates a random `state`, stores it in a short-lived httpOnly cookie
      → redirects to GitHub's consent screen

2. User approves on GitHub

3. GET /api/auth/github/callback?code=...&state=...
      → verifies `state` matches the cookie (CSRF protection — see below)
      → exchanges `code` for a GitHub access token
      → fetches the GitHub profile + primary VERIFIED email
      → find-or-create-or-link a User (see below)
      → sets the refresh token cookie
      → redirects to {FRONTEND_URL}/auth/callback  (NOT with a token in the URL)

4. Frontend's /auth/callback page immediately calls POST /api/auth/refresh
      → reads the httpOnly cookie just set, returns a fresh access token
        straight into memory
```

**Why the access token never appears in the redirect URL.** URLs end up
in browser history and server access logs — putting a bearer token there
means it lives on well past the moment it was needed. Landing on a
callback page that immediately trades the httpOnly cookie for a token
avoids ever putting a credential somewhere it'll be logged.

**The `state` cookie is `SameSite=Lax`, not `Strict`.** This is
deliberate, not an oversight — GitHub's redirect back to the callback URL
is a cross-site *top-level navigation*. A `Strict` cookie would not be
sent on that request at all, which would break the CSRF check the state
parameter exists to perform. `Lax` is the correct setting for a cookie
that specifically needs to survive exactly one cross-site redirect.

### Find-or-create-or-link

```
1. profile.id already linked to a User      → log that user in
2. no link, but a VERIFIED email matches
   an existing password-based account        → link GitHub to it, log in
3. neither                                    → create a new account
```

Step 2 only ever triggers on a **verified** email
(`fetchPrimaryVerifiedGithubEmail` explicitly filters for
`primary && verified`). This is the line that prevents account takeover:
GitHub lets a user set any email as a *profile* field regardless of
whether they own it, but the `/user/emails` endpoint's `verified` flag
can't be spoofed the same way — it reflects GitHub's own verification,
not something the OAuth app controls. Auto-linking on an unverified email
would mean anyone could claim someone else's existing account just by
typing their email into a GitHub profile.

A GitHub user with no public/verified email at all still gets an account —
`email` is `NOT NULL UNIQUE` on the `User` table, so one is synthesized:
`{githubId}+{login}@users.noreply.github.com`, guaranteed unique by
construction (GitHub's own numeric user ID is in it).

## Middleware: `requireAuth`

Every protected route runs through one middleware that does exactly one
job — verify the `Authorization: Bearer <token>` header, attach
`{ id, email }` to `req.user`, and call `next()`. The one thing worth
noticing is that it distinguishes **why** verification failed:

```ts
if (err instanceof jwt.TokenExpiredError) {
  return next(new UnauthorizedError('Access token expired', 'TOKEN_EXPIRED'));
}
return next(new UnauthorizedError('Invalid access token', 'INVALID_TOKEN'));
```

The frontend's fetch/axios interceptor checks for exactly the
`TOKEN_EXPIRED` code to decide whether it's safe to attempt a silent
`/refresh` and retry — vs. `INVALID_TOKEN` (a malformed or tampered
token), which goes straight to the login page instead. Collapsing both
into one generic 401 would mean a routine, expected token expiry looks
identical to an actual security-relevant failure, and the frontend
couldn't tell them apart to react differently.

## GitHub tokens at rest

A user's GitHub access token (needed for repo listing, cloning private
repos, and reading files during framework detection) is stored
**encrypted**, not plaintext, via `lib/crypto.ts`'s
`encryptForStorage`/`decryptFromStorage` (AES, keyed by `ENCRYPTION_KEY`
— see the [top-level README](../../../README.md)'s `install.sh` for how that key gets
generated). Every place that reads it back out
(`build-config.controller.ts`, `deployment.service.ts` for private-repo
clones) decrypts it fresh, on demand — it's never held decrypted longer
than the single operation that needs it.

## Sessions UI

`GET /api/auth/sessions` lists every active `UserSession` for the current
user (device/IP/last-used, never the token itself), and
`DELETE /api/auth/sessions/:sessionId` revokes one — this is what powers
a "log out this device" list in account settings. `POST
/api/auth/logout-all` revokes every session at once, used after a
password change so an attacker who had a valid session before the
password was changed gets kicked out too.

## Endpoint reference

| Method | Path | Auth required | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | No | Create an email/password account |
| POST | `/api/auth/login` | No | Email/password login |
| POST | `/api/auth/refresh` | No (cookie) | Exchange refresh cookie for a new access token |
| POST | `/api/auth/logout` | No (cookie) | Revoke the current session |
| POST | `/api/auth/logout-all` | Yes | Revoke every session for this user |
| GET | `/api/auth/me` | Yes | Current user's profile |
| GET | `/api/auth/sessions` | Yes | List active sessions |
| DELETE | `/api/auth/sessions/:id` | Yes | Revoke one session |
| POST | `/api/auth/change-password` | Yes | Change password (requires current password if one is set) |
| GET | `/api/auth/github` | No | Start the GitHub OAuth flow |
| GET | `/api/auth/github/callback` | No | GitHub redirects here |

All login/register/refresh routes are rate-limited
(`loginRateLimiter`/`registerRateLimiter`/`refreshRateLimiter`) — see
`middleware/rate-limiter.middleware.ts`.
