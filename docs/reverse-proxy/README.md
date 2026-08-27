# reverse-proxy

`reverse-proxy` is the single hostname every deployed app is actually
reached through. It's a small, standalone Express service — no
`api-server`, no dashboard, no auth — with exactly one job: given a
request for `{something}.yourdomain.com` (or a verified custom domain),
figure out what that hostname is currently serving, and proxy the request
there.

It never touches the public internet directly. `nginx` terminates TLS for
the wildcard domain and forwards to it over the private compose network,
preserving the original `Host` header — see the topology section below.

## Why a dedicated service, not part of `api-server`

Every request to every deployed app — including apps that have nothing
to do with the dashboard itself — passes through this service. Folding it
into `api-server` would mean a traffic spike on one deployed app competes
for the same process, the same connection pool, the same event loop as
the actual control plane. Keeping it separate means a deployed app
misbehaving (or just being popular) can't degrade the dashboard, and vice
versa.

## Request handling, step by step

```js
app.use(async (req, res) => {
  const hostname = req.hostname;   // "myapp.yourdomain.com" or "mycompany.com"

  const route = await resolveRoute(hostname, BASE_DOMAIN);

  if (!route) {
    res.status(404).send('No deployment found for this domain');
    return;
  }

  if (route.type === 'DYNAMIC') {
    proxy.web(req, res, { target: route.appUrl, changeOrigin: true });
    return;
  }

  const resolvesTo = `${BASE_PATH}/${route.slug}`;
  proxy.web(req, res, { target: resolvesTo, changeOrigin: true });
});
```

One handler, one branch. Everything else in this service exists to make
`resolveRoute()` correct and fast.

### Step 1: two lookup paths, chosen by hostname shape

```
1. {slug}.${BASE_DOMAIN}   — the free URL every project already has.
                              Match Project.slug against the hostname's
                              first label.
2. Anything else           — an exact match against CustomDomain.domain.
                              Only a VERIFIED row routes (unverified would
                              mean routing traffic for a domain nobody's
                              proven they own). The domain CNAMEs to
                              `cname.${BASE_DOMAIN}` per the DNS setup
                              instructions, so it arrives here with its
                              own hostname intact, not rewritten to ours.
```

Both paths resolve to the SAME project's `activeDeploymentId` — a custom
domain always points at whatever the subdomain already points at, never
a separately-chosen deployment.

### Step 2: `resolveRoute` — the one query this whole service exists to run

```sql
SELECT p.id AS "projectId", d.id AS "deploymentId", p.slug AS "slug",
       d.type AS "type", d."outputPrefix" AS "outputPrefix", d."appUrl" AS "appUrl"
FROM "Project" p
JOIN "Deployment" d ON d.id = p."activeDeploymentId"
WHERE p.slug = $1 AND p."deletedAt" IS NULL
```
(the custom-domain branch joins through `"CustomDomain"` instead of
matching on slug; everything else is identical.)

Three things worth noticing about this query:

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
  history) still physically exists in the database. This is also why
  project deletion needs no network-level teardown work.
- A missing row (no project with that hostname, or no active deployment)
  and a project that's plainly gone are indistinguishable from this
  query's result — both come back empty, and both correctly produce a
  404. This service has no reason to know or care *why* nothing matched.

The resolved row carries `slug` alongside everything else deliberately:
the STATIC branch builds its object-store prefix from `route.slug`, not
from the hostname — those coincide for `{slug}.yourdomain.com` requests
but diverge completely for custom domains, whose hostname has no
relationship to any project slug at all.

### Why this query goes straight to `pg`, not Prisma

`reverse-proxy` uses a plain `pg.Pool`, not the generated Prisma client
`api-server` uses everywhere else. This is a deliberate exception, not
an oversight: this is the one query in the entire system that runs on
**every single request to every deployed app** — pulling in the full
Prisma client (its generated types, its query engine) for one read-only
query is a materially heavier dependency than this narrow, latency-
sensitive path needs.

### The two-tier cache

```
L1: in-process Map keyed by full hostname, ~5s TTL, capped at 10k entries
        ↓ miss
L2: Redis, 30s TTL (keyed `route:{hostname}`, misses cached as 'null')
        ↓ miss
Postgres
```

Without any caching, **every** request to **every** deployed app would
cost a Postgres round trip before it could even start proxying — a tax
paid on the hot path of every single visitor to every single deployed
project. The tiers split the work:

- **L2 (Redis, 30s)** is what keeps a newly-`RUNNING` deployment
  resolving correctly well within any reasonable "just deployed, why
  isn't it live yet" wait, even before invalidation kicks in.
- **L1 (~5s, in-process)** absorbs *bursts* — many concurrent visitors
  to the same hostname, or one visitor loading several sub-resources
  back to back — so hot hostnames don't cost a Redis command per request
  forever. It's deliberately much shorter than L2 so every request still
  defers to Redis within seconds regardless of which tier served it.
- **Misses are cached too** — the literal string `'null'` at L2, and the
  actual `null` value at L1. A typo'd or long-deleted hostname doesn't
  get a fresh Postgres query on every single request either.
- **Active invalidation** makes the common case instant anyway:
  `api-server`'s `invalidateRouteCache` clears both the slug key and
  every verified custom-domain key for a project when its active
  deployment changes, rather than waiting out the TTLs.

## Step 3: the two very different proxy targets

**STATIC** — proxies to the MinIO HTTPS endpoint built from the
project's slug (`${BASE_PATH}/${route.slug}`, where `BASE_PATH` already
includes the `__outputs` prefix every build uploaded under). See
[static deployments](../deployments/static-deployments.md) for the
`/` → `/index.html` rewrite this path also needs, scoped specifically to
STATIC requests via a `req.dreamerRouteType` flag set before the
`proxy.web()` call — applying that rewrite to a DYNAMIC request would
corrupt the path before it ever reaches the app's own router.

**DYNAMIC** — proxies straight to the deployment's running app container
(`http://dreamer-app-{slug}:3000`) over the private compose network. No
path rewriting applies here at all — the app's own server sees requests
exactly as they arrived.

A RUNNING dynamic deployment whose row somehow lacks an app URL returns
a 502 instead of proxying to `undefined` — defensive, but cheap.

## Per-project metrics, recorded at the edge

Because this service sees every request, it's also where per-project
traffic metrics get recorded: once a route resolves, the response's
`finish` event fires `recordRequest(projectId, ip, statusCode,
responseTimeMs, bytes)` — after the full response has actually been sent,
so status codes and byte counts reflect what the client received, never
before it. Recording is fire-and-forget into an in-process accumulator
drained to Redis on a timer — a storage hiccup must never affect the
proxied response itself. Unroutable requests (404s) are deliberately not
recorded — there's no project to attribute them to.

## Self-hosted topology: nginx in front, `reverse-proxy` behind it

In the compose stack, `nginx` is the only service that publishes ports to
the world (80/443). It terminates TLS for the wildcard certificate and
forwards to `reverse-proxy` on the private network, preserving the
original `Host` header so `resolveRoute()` still sees the real hostname
the visitor typed:

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

There is deliberately **no dashboard server block here at all** — no
apex, no www, no api hostname. The control plane is loopback-only
(reached via SSH tunnel), and the only other public listener nginx has
is the opt-in push-to-deploy webhook block (`hooks.yourdomain.com`,
which proxies exactly one path to `api-server` and answers nothing else
— see [`SELF-HOSTING.md`](../SELF-HOSTING.md)).

## Going deeper on wildcard TLS specifically

If you're setting up your domain and hit anything unexpected around
certificates — how the wildcard-only certificate gets issued, why the
bare apex isn't included, or what changes for a two-level namespace like
`*.apps.yourdomain.com` — see
[**Wildcard Domains**](./wildcard-domains.md).
