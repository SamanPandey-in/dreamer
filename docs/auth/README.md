# Authentication

This is a single-operator system: one admin account, created once during
first-run setup, running on hardware you own. That shape drives every
auth decision here — what was kept (a real session system) and what was
deliberately dropped (everything that only makes sense for strangers
signing up to a hosted service).

## The one-time setup

```
POST /api/auth/setup  { name, email, password }
```

Creates the one admin account — and **only ever works while zero users
exist in the database**; it 409s permanently the instant an admin has
been created. The dashboard's first-run screen calls this once; reload
after and you get the normal login screen instead. This is the standard
self-hosted first-run pattern (the same one Coolify and CapRover use),
and it's why there's no "sign up" anywhere in this system — you either
are the operator or you don't have an account.

`GET /api/auth/setup-status` tells the frontend which of the two screens
to render.

**What deliberately doesn't exist here:** open self-registration,
"Continue with GitHub" OAuth login, mandatory email verification, and
email-based forgot/reset-password flows. None of that serves a single
trusted operator — and email verification specifically would require
configuring a transactional email provider just to finish installing the
app, a setup-cost tax for zero benefit. Forgot the admin password? Reset
it directly from the server:

```bash
docker compose --env-file .env.deploy exec api-server \
  npx tsx scripts/reset-admin-password.ts your-new-password
```

This also signs out every existing session for the account, same as a
normal in-app password change does. Requiring host access is the point:
it's the same trust boundary as everything else on a single-operator box.

## Two token types, two different jobs

The session mechanics underneath the single admin are a real login
system, kept fully intact:

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
a race against your own next page load, not a standing, indefinite
backdoor.

## Constant-time login, on purpose

`login()` runs a bcrypt comparison *unconditionally*, even when the email
doesn't exist in the database at all:

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
this explicitly rather than letting a 200-character password get set that
bcrypt quietly treats as its first 72 characters.

## Git access: one Personal Access Token, no GitHub App

A GitHub App exists to solve "many different users' repos need scoped,
revocable, per-installation access." That problem doesn't exist when
there's one operator authenticating against their own repos — so git
access here is a plain **Personal Access Token**, the same mechanism every
`git clone https://TOKEN@github.com/...` workflow has used for over a
decade.

- Set it once in the dashboard under **Settings → Git** (`PUT
  /api/auth/git-token`, cleared with `DELETE /api/auth/git-token`). Public
  repos need no token at all — it's only required for cloning private ones.
- It's stored **encrypted at rest** via `lib/crypto.ts`'s
  `encryptForStorage`/`decryptFromStorage` (AES-256-GCM, keyed by
  `ENCRYPTION_KEY` — see [`SELF-HOSTING.md`](../SELF-HOSTING.md) for how
  that key gets generated). Every place that reads it back out decrypts
  it fresh, on demand — never held decrypted longer than the single
  operation that needs it.
- The wizard's repo picker uses it against GitHub's plain
  `GET /user/repos`; the build worker decrypts it right before launching
  a build container — and it must **never** sit in the persisted queue
  payload, so the decryption happens in the worker at dequeue time, not
  enqueue time.

That's the whole credential model: one encrypted PAT, no App
registration, no installation flow, no token cache to invalidate.

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
| GET | `/api/auth/setup-status` | No | Has the admin account been created yet? |
| POST | `/api/auth/setup` | No (once ever) | Create the single admin account; 409s forever after |
| POST | `/api/auth/login` | No | Email/password login |
| POST | `/api/auth/refresh` | No (cookie) | Exchange refresh cookie for a new access token |
| POST | `/api/auth/logout` | No (cookie) | Revoke the current session |
| POST | `/api/auth/logout-all` | Yes | Revoke every session for this user |
| GET | `/api/auth/me` | Yes | Current user's profile |
| GET | `/api/auth/sessions` | Yes | List active sessions |
| DELETE | `/api/auth/sessions/:id` | Yes | Revoke one session |
| POST | `/api/auth/change-password` | Yes | Change password (requires current password) |
| PUT | `/api/auth/git-token` | Yes | Store the git Personal Access Token (encrypted) |
| DELETE | `/api/auth/git-token` | Yes | Remove the stored token |

All login/setup/refresh routes are rate-limited
(`loginRateLimiter`/`setupRateLimiter`/`refreshRateLimiter`) — see
`middleware/rate-limiter.middleware.ts`.
