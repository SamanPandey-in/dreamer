# Static Deployments, From Scratch

This is the original, simplest deployment path in this system — a repo
that produces a folder of static files (HTML/CSS/JS, no server process
required to serve it). Covers everything from the moment `build-engine`
picks up the job to a visitor's browser actually receiving those files.

If you're trying to understand this system by building your own version
from nothing, this is the doc to start with — dynamic (SSR) deployments
build on every concept introduced here.

## Why an object store, and why one prefix per project

Static output is just files — no compute needed to serve them, which
makes an object store the obvious fit: durable, cheap, and — critically
for this platform — it means "serving a deployed app" never touches
`api-server`'s own compute or database connections at all. A spike in
traffic to one deployed app can't degrade the platform's own dashboard.

The store here is **MinIO**, running as one of the nine compose services.
It speaks the industry-standard S3-compatible protocol — which is why the
build container's client code reads exactly like any object-store upload
would — with the
bucket created at startup (`dreamer-outputs`) and given an anonymous
download policy so `reverse-proxy` can fetch from it without embedding
storage credentials in the hot path of every request.

Every file a build produces is uploaded under one key prefix, keyed by
the **project's** slug, not the deployment's:

```
__outputs/{project.slug}/{relative file path}
```

This is the same "one live thing per project" rule covered in the
[deployments overview](./overview.md#redeploying) — every deployment of
the same project overwrites the same prefix. There's no versioning, no
"deployment #12's files" living alongside "deployment #13's files" — the
newest successful build simply replaces what was there.

## The build, step by step

This is `build-engine`'s `runStaticBuild()`, run inside its throwaway
build container (see [architecture overview](../architecture/overview.md)
for why builds get their own container instead of sharing a process):

```
1. npm install   (or pnpm/yarn/bun — see framework-detection docs)
2. npm run build
3. Verify the configured OUTPUT_DIRECTORY actually exists on disk
4. Walk every file in it, upload each one to MinIO
5. Publish RUNNING with the public URL + file count
```

Install and build run as two separate sequential steps (not one chained
`&&`) specifically so a failure can be attributed to INSTALL vs BUILD —
`Deployment.errorStep` exists precisely to answer "which step failed:
install | build | upload," and collapsing both into a single shell call
would make that column impossible to populate correctly.

### Step 3: verifying the output directory exists

```ts
const distFolderPath = path.join(buildContextPath, OUTPUT_DIRECTORY);

if (!fs.existsSync(distFolderPath)) {
  const notFoundError = new Error(
    `Build finished but expected output directory "${OUTPUT_DIRECTORY}" was not found at ${distFolderPath} — ` +
    `check that the project's Output Directory setting matches what "${BUILD_COMMAND}" actually produces`
  );
  notFoundError.step = 'build';
  throw notFoundError;
}
```

This one check is what turns "the build silently succeeded but there's
nothing to serve" (a genuinely confusing failure mode — everything LOOKS
fine, `npm run build` exited 0) into a specific, actionable error message
in the build log, pointing directly at the mismatch between what the
framework preset assumed and what actually got built.

### Step 4: the upload loop

```ts
const distFolderContents = fs.readdirSync(distFolderPath, { recursive: true });

for (const file of distFolderContents) {
  const filePath = path.join(distFolderPath, file);
  if (fs.lstatSync(filePath).isDirectory()) continue;

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: `__outputs/${PROJECT_SLUG}/${file}`,
    Body: fs.createReadStream(filePath),
    ContentType: mime.lookup(filePath) || 'application/octet-stream',
  });

  await s3Client.send(command);
}
```

Two details that matter:

- **`ContentType` is set explicitly, per file**, via the `mime-types`
  package inferring from the file extension. Without this, objects get
  served with a generic `application/octet-stream` content type by
  default — browsers won't render an `.html` file as HTML or execute a
  `.js` file as a script without the correct header telling them to.
- **Streamed, not buffered** — `fs.createReadStream(filePath)` as the
  `Body`, not a full `readFileSync`. A build with large assets (video,
  large images, source maps) doesn't need to hold the whole file in
  memory before it can start uploading.

### Step 5: what "RUNNING" actually means for STATIC

```ts
const url = `https://${PROJECT_SLUG}.${BASE_DOMAIN}`;
publishStatus('RUNNING', { url, uploadedFileCount: uploadedCount });
```

There's no separate "starting" phase the way DYNAMIC has (see that doc)
— the moment the last file lands in MinIO, the deployment IS live; an
object store doesn't need to "start up." `uploadedFileCount` is purely
informational, surfaced in the dashboard's build summary.

## Serving: how `reverse-proxy` turns a subdomain into an object fetch

See [reverse-proxy docs](../reverse-proxy/README.md) for the full routing
picture across both deployment types. The STATIC-specific piece:

```js
const resolvesTo = `${BASE_PATH}/${route.slug}`;
proxy.web(req, res, { target: resolvesTo, changeOrigin: true });
```

`BASE_PATH` is the MinIO endpoint's HTTPS URL plus the `__outputs`
prefix; `route.slug` completes the same key prefix every upload wrote
to. Note the lookup hands back the **project slug**, not the raw
hostname label — those happen to coincide for `{slug}.yourdomain.com`
requests, but a custom domain's hostname (`mycompany.com`) has no
relationship to any slug at all, so the prefix must come from the
resolved route row, never from string-splitting the hostname.

**One deliberate quirk: the `/` → `/index.html` rewrite.**

```js
proxy.on('proxyReq', (proxyReq, req, _res) => {
  if (req.dreamerRouteType === 'STATIC' && req.url === '/') {
    proxyReq.path += 'index.html';
  }
});
```

An object store is a flat key space — there is no object literally named
`""` at a bucket root, so a request for `/` has nothing to match unless
something rewrites it to the actual object that exists,
`__outputs/{slug}/index.html`. This rewrite is scoped to STATIC requests
only (`req.dreamerRouteType`, set earlier in the request handler) —
applying it to a DYNAMIC request would corrupt the path before it ever
reaches a running app server's own router.

This is also, not coincidentally, why a single-page app's client-side
router works at all through this proxy for the root path but a **deep
link** (`/dashboard/settings` on first load, not a client-side
navigation) does NOT automatically work — this rewrite only covers the
exact bare `/` path, not every unmatched route. A production version of
this platform would extend this to a proper SPA fallback (any 404 from
the store retried against `index.html`); as shipped, it covers the
common case (the root path) and no more.

## Teardown

Two places delete an output prefix, both calling the same
`deleteS3Prefix(prefix)`:

- **Stopping a `RUNNING` static deployment** (only if it's the project's
  current `activeDeploymentId` — see
  [deployments overview](./overview.md#stopping-a-deployment)).
- **Deleting a project entirely** — see
  [projects docs](../projects/README.md#deleting-a-project). Best-effort:
  a storage failure here logs an error but never blocks the delete itself.

Without this cleanup, a *different, future* project that happens to land
on the same slug (see the collision handling in
[projects docs](../projects/README.md#slugs-the-projects-public-identity))
would silently inherit a deleted project's stale files until its own
first successful deploy overwrites them.
