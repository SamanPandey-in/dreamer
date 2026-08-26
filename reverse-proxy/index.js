const express = require('express')
const httpProxy = require('http-proxy')
const { resolveRoute } = require('./deployment-lookup')
const { recordRequest, startFlushLoop, stopFlushLoop } = require('./metrics-recorder')
const app = express()

const PORT = process.env.PORT || 9000
const BASE_PATH = process.env.BASE_PATH
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'singularitydev.xyz'

const proxy = httpProxy.createProxy()

// NEW — needed for req.ip (used by metrics-recorder.js to approximate
// unique visitors) to resolve to the real client address instead of
// nginx's. Same "trust exactly one hop" reasoning as api-server's app.ts —
// nginx (see nginx/templates/dreamer.conf.template's X-Forwarded-For) sits
// exactly one hop in front of this service too.
app.set('trust proxy', 1)

// CHANGED — replaces the previous hardcoded `${BASE_PATH}/${subdomain}`
// string interpolation (which proxied EVERY hostname to S3, including
// ones with no project behind them at all — the literal `// TODO: replace
// with real DB lookup` this used to carry) with a real lookup, and adds
// the DYNAMIC branch STATIC-only reverse-proxy never needed: for a
// DYNAMIC deployment, this app has no static output to proxy to at all — it
// proxies to the deployment's own app container instead.
app.use(async (req, res) => {
    const hostname = req.hostname // "myapp.singularitydev.xyz" OR a custom domain like "polyglot.com"

    let route
    try {
        route = await resolveRoute(hostname, BASE_DOMAIN)
    } catch (err) {
        console.error(`[resolveRoute] lookup failed for "${hostname}":`, err)
        res.status(502).send('Routing lookup failed')
        return
    }

    if (!route) {
        // No project/custom-domain with this hostname, or the project has
        // no RUNNING deployment — a bare 404 instead of proxying to a dead
        // S3 prefix (the old behavior: it would proxy anyway, and S3 itself
        // would 404, which worked but only by accident — this project has
        // no Deployment row backing it at all, so there's genuinely
        // nothing to serve). Deliberately NOT recorded as a metric below
        // — there's no project to attribute it to.
        res.status(404).send('No deployment found for this domain')
        return
    }

    // NEW — every code path below this point resolved to a real project,
    // so metrics can be attributed to it. Recorded on the response's
    // 'finish' event (after the full response has actually been sent, so
    // statusCode/bytes reflect what the client received) rather than here,
    // and never awaited — see metrics-recorder.js's own comment for why a
    // Redis hiccup here must never affect the proxied response itself.
    const requestStartedAt = process.hrtime.bigint()
    res.once('finish', () => {
        const responseTimeMs = Number(process.hrtime.bigint() - requestStartedAt) / 1_000_000
        const bytesTransferred = Number(res.getHeader('content-length')) || 0
        recordRequest(route.projectId, req.ip, res.statusCode, responseTimeMs, bytesTransferred)
    })

    if (route.type === 'DYNAMIC') {
        if (!route.appUrl) {
            // Shouldn't happen for a RUNNING dynamic deployment — RUNNING is
            // only ever set (see handleImageReady in deployment.service.ts)
            // AFTER appUrl is persisted — but defends against a
            // half-migrated row rather than proxying to `undefined`.
            res.status(502).send('Deployment is misconfigured (no app container URL)')
            return
        }

        req.dreamerRouteType = 'DYNAMIC'
        // changeOrigin: true rewrites the outbound Host header to match
        // the target — harmless here (the app container doesn't care what
        // Host header it sees), but left on for consistency with how this
        // was always set for the DYNAMIC branch.
        proxy.web(req, res, { target: route.appUrl, changeOrigin: true })
        return
    }

    // STATIC (unchanged behavior, now driven by a confirmed DB row instead
    // of a blind guess): proxy to this project's MinIO output prefix.
    //
    // CHANGED — uses route.slug (now selected by resolveRoute) instead of
    // the removed `subdomain` variable. That derivation only ever worked
    // because a subdomain request's hostname label happened to equal the
    // project slug; a custom domain's hostname (e.g. "polyglot.com") has
    // no such relationship to the project at all — route.slug is the only
    // correct source for this output-prefix interpolation now, regardless of
    // which hostname shape the request came in as.
    req.dreamerRouteType = 'STATIC'
    const resolvesTo = `${BASE_PATH}/${route.slug}`
    proxy.web(req, res, { target: resolvesTo, changeOrigin: true })
})

proxy.on('proxyReq', (proxyReq, req, _res) => {
    // S3-specific: a request for "/" has no object at that exact key, S3
    // has no directory-index behavior of its own — this rewrite is what
    // makes "/" resolve to "index.html". Scoped to STATIC only (via the
    // req.dreamerRouteType set above) because doing this to a DYNAMIC
    // request would corrupt the path Next.js's own router needs to see
    // unchanged — appending "index.html" to "/" before it reaches a
    // containerized Next.js server breaks its routing outright.
    if (req.dreamerRouteType === 'STATIC' && req.url === '/') {
        proxyReq.path += 'index.html'
    }
})

proxy.on('error', (err, _req, res) => {
    console.error('[proxy error]', err)
    if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
    }
    res.end('Bad gateway')
})

app.listen(PORT, () => {
    console.log(`Reverse Proxy Server running on port ${PORT}`)
    // NEW — starts draining metrics-recorder.js's in-process accumulator
    // to Redis on a timer. See that module's own top-of-file comment for
    // why this replaced a per-request Redis write.
    startFlushLoop()
})

// NEW — a graceful shutdown (deploy, scale-down) gets one last metrics
// flush instead of silently dropping whatever's buffered since the last
// timer tick. A hard crash/kill -9 still loses it — see metrics-recorder.js's
// own trade-off comment — this only covers the graceful path, same
// limitation api-server's own shutdown handling (src/index.ts) already
// accepts for its own in-flight work.
async function shutdown(signal) {
    console.log(`Received ${signal}, flushing metrics and shutting down`)
    await stopFlushLoop()
    process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
