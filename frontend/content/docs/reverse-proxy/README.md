# reverse-proxy

`reverse-proxy` is the single hostname every deployed app is actually
reached through. It's a small, standalone Express service — no
`api-server`, no dashboard, no auth — with exactly one job: given a
request for `{something}.yourdomain.com`, figure out what that
subdomain is currently serving, and proxy the request there.

## Why a dedicated service, not part of `api-server`

Every request to every deployed app — including apps that have nothing
to do with the Dreamer dashboard itself — passes through this service.
Folding it into `api-server` would mean a traffic spike on one deployed
app competes for the same process, the same connection pool, the same
event loop as the actual control plane. Keeping it separate means a
deployed app misbehaving (or just being popular) can't degrade the
dashboard, and vice versa.

It's also, deliberately, the **one** service in this system simple
enough to run outside the "normal" application stack entirely — see the
[top-level README](../../../README.md), where it's just another
container behind nginx, with its own narrow Postgres/Redis dependency
and nothing else.

## Request handling, step by step

```js
app.use(async (req, res) => {
  const hostname = req.hostname;              // "myapp.yourdomain.com"
  const subdomain = hostname.split('.')[0];    // "myapp"

  const route = await resolveRoute(subdomain);

  if (!route) {
    res.status(404).send('No deployment found for this subdomain');
    return;
  }

  if (route.type === 'DYNAMIC') {
    proxy.web(req, res, { target: route.appUrl, changeOrigin: true });
    return;
  }

  const resolvesTo = `${BASE_PATH}/${subdomain}`;
  proxy.web(req, res, { target: resolvesTo, changeOrigin: true });
});
```

One handler, one branch. Everything else in this service exists to make
`resolveRoute()` correct and fast.

### Step 1: the subdomain IS the lookup key

`req.hostname.split('.')[0]` — no path parsing, no header inspection
beyond what Express already gives you. This works because the subdomain
is, by construction, exactly `Project.slug` (see
[projects docs](../projects/README.md#slugs-the-projects-public-identity))
— there's no separate mapping table to consult, the hostname the visitor
typed already IS the identifier.

### Step 2: `resolveRoute` — the one query this whole service exists to run

```sql
SELECT d.type AS "type", d."outputPrefix" AS "outputPrefix", d."appUrl" AS "appUrl"
FROM "Project" p
JOIN "Deployment" d ON d.id = p."activeDeploymentId"
WHERE p.slug = $1 AND p."deletedAt" IS NULL
```

Two things worth noticing about this query:

- **It joins through `Project.activeDeploymentId`**, not "the newest
  deployment for this project." A project can have many `Deployment`
  rows (every build ever run), but only one is ever "live" at a time —
  this is the same field `stopDeployment()` and the redeploy flow both
  read and write (see
  [deployments overview](../deployments/overview.md#redeploying)). A
  deployment that failed, or one that was superseded by a later
  redeploy, is simply never reachable through this join, with zero extra
  filtering logic needed here.
- **`deletedAt IS NULL`** — a soft-deleted project (see
  [projects docs](../projects/README.md#deleting-a-project)) stops
  resolving immediately, even though its row (and its `Deployment`
  history) still physically exists in the database.

A missing row (no project with that slug, or a project with no active
deployment at all) and a project that's plainly gone are
indistinguishable from this query's result — both just come back empty,
and both correctly produce a 404. This service has no reason to know or
care *why* nothing matched.

### Why this query goes straight to `pg`, not Prisma

`reverse-proxy` uses a plain `pg.Pool`, not the generated Prisma client
`api-server` uses everywhere else. This is a deliberate exception, not
an oversight: this is the one query in the entire system that runs on
**every single request to every deployed app** — pulling in the full
Prisma client (its generated types, its query engine) for one read-only
query is a materially heavier dependency than this narrow, latency-
sensitive path needs.

### The 30-second cache

```js
const cacheKey = `${CACHE_KEY_PREFIX}${subdomain}`;
const cached = await cache.get(cacheKey);
if (cached !== null) {
  return cached === 'null' ? null : JSON.parse(cached);
}

const result = await pool.query(/* ... */);
const route = result.rows[0] ?? null;

await cache.set(cacheKey, route ? JSON.stringify(route) : 'null', 'EX', 30);
return route;
```

Without this, **every** request to **every** deployed app would cost a
Postgres round trip before it could even start proxying — a tax the
service pays on the hot path of every single visitor to every single
deployed project. 30 seconds is short enough that a newly-`RUNNING`
deployment starts resolving correctly well within any reasonable "just
deployed, why isn't it live yet" wait, with zero separate
cache-invalidation plumbing needed back in `api-server` — the cache just
naturally expires and re-queries.

**Misses are cached too** — the literal string `'null'` (disambiguated
from a JSON-serialized actual `null` value, which would also stringify
to `'null'`, by the ternary checking the ORIGINAL `route` value, not the
cached string, before deciding how to interpret what came back). A
typo'd or long-deleted subdomain doesn't get a fresh Postgres query on
every single request either — it gets the same 30-second cache treatment
as a hit.

### Step 3: the two very different proxy targets

**STATIC** — proxies to a MinIO HTTPS URL built from the subdomain
directly (`${BASE_PATH}/${subdomain}`, where `BASE_PATH` already
includes the `__outputs` prefix every build uploaded under). See
[static deployments](../deployments/static-deployments.md) for the
`/` → `/index.html` rewrite this path also needs, scoped specifically to
STATIC requests via a `req.dreamerRouteType` flag set before the
`proxy.web()` call — applying that rewrite to a DYNAMIC request would
corrupt the path before it ever reaches the app's own router.

**DYNAMIC** — proxies straight to the deployment's own app container, at
its container-to-container URL (`http://dreamer-app-{slug}:3000`) on the
shared `dreamer-local` Docker network, with `changeOrigin: true`. No
static-output rewrite applies here at all — the app container's own
Next.js server handles routing the request unmodified.

## Self-hosted topology: nginx in front, `reverse-proxy` behind it

When self-hosting the whole platform (see the
[top-level README](../../../README.md)), `reverse-proxy` itself never
touches the public internet directly — nginx terminates TLS for the
wildcard domain and forwards to `reverse-proxy` over the private compose
network, preserving the original `Host` header so `resolveRoute()` still
sees the real subdomain the visitor typed:

```nginx
server {
    listen 443 ssl;
    server_name *.yourdomain.com;
    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;

    location / {
        proxy_pass http://reverse-proxy:9000;
        proxy_set_header Host $host;
        # ...
    }
}
```

This is the same reason a wildcard TLS certificate has to cover both
the bare apex domain (the dashboard) AND `*.yourdomain.com` (every
deployed app) as SANs in one certificate — see the Self-Hosting Guide's
certificate section for the full reasoning.

## Going deeper on wildcard TLS specifically

If you're setting up a custom domain and hit anything unexpected around
certificates — a wildcard that isn't actually covered, a PaaS custom-
domain flow that doesn't behave the way you expected, or you're
wondering how any of this differs on a self-hosted VPS versus a managed
host — see [**Wildcard Domains**](./wildcard-domains.md), which covers
the two genuinely different kinds of wildcard ( `*.domain.com` vs.
`*.sub.domain.com` ) and walks through a real production setup for both.
