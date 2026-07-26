const express = require('express')
const httpProxy = require('http-proxy')
const { resolveRoute } = require('./deployment-lookup')
const app = express()

const PORT = process.env.PORT || 9000
const BASE_PATH = process.env.BASE_PATH
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'singularitydev.xyz'

const proxy = httpProxy.createProxy()

// CHANGED — replaces the previous hardcoded `${BASE_PATH}/${subdomain}`
// string interpolation (which proxied EVERY hostname to S3, including
// ones with no project behind them at all — the literal `// TODO: replace
// with real DB lookup` this used to carry) with a real lookup, and adds
// the DYNAMIC branch STATIC-only reverse-proxy never needed: for a
// DYNAMIC deployment, this app has no S3 output to proxy to at all — it
// proxies to the deployment's own Lambda Function URL instead.
app.use(async (req, res) => {
    const hostname = req.hostname // e.g. "myapp.singularitydev.xyz"
    const subdomain = hostname.split('.')[0] // "myapp"

    let route
    try {
        route = await resolveRoute(subdomain)
    } catch (err) {
        console.error(`[resolveRoute] lookup failed for "${subdomain}":`, err)
        res.status(502).send('Routing lookup failed')
        return
    }

    if (!route) {
        // No project with this slug, or the project has no RUNNING
        // deployment — a bare 404 instead of proxying to a dead S3
        // prefix (the old behavior: it would proxy anyway, and S3 itself
        // would 404, which worked but only by accident — this project has
        // no Deployment row backing it at all, so there's genuinely
        // nothing to serve).
        res.status(404).send('No deployment found for this subdomain')
        return
    }

    if (route.type === 'DYNAMIC') {
        if (!route.lambdaFunctionUrl) {
            // Shouldn't happen for a RUNNING dynamic deployment — RUNNING is
            // only ever set (see handleImageReady in deployment.service.ts)
            // AFTER lambdaFunctionUrl is persisted — but defends against a
            // half-migrated row rather than proxying to `undefined`.
            res.status(502).send('Deployment is misconfigured (no Lambda Function URL)')
            return
        }

        req.dreamerRouteType = 'DYNAMIC'
        // changeOrigin: true is REQUIRED here, unlike the STATIC branch's
        // historical reasoning — each deployment's Function URL is its own
        // unique hostname (xxxx.lambda-url.{region}.on.aws), not a
        // shared host-header-routed front door, so the outbound Host
        // header must be rewritten to match it, or AWS's own edge
        // rejects the request before it ever reaches the function.
        proxy.web(req, res, { target: route.lambdaFunctionUrl, changeOrigin: true })
        return
    }

    // STATIC (unchanged behavior, now driven by a confirmed DB row instead
    // of a blind guess): proxy to this project's S3 output prefix.
    req.dreamerRouteType = 'STATIC'
    const resolvesTo = `${BASE_PATH}/${subdomain}`
    proxy.web(req, res, { target: resolvesTo, changeOrigin: true })
})

proxy.on('proxyReq', (proxyReq, req, _res) => {
    // S3-specific: a request for "/" has no object at that exact key, S3
    // has no directory-index behavior of its own — this rewrite is what
    // makes "/" resolve to "index.html". Scoped to STATIC only (via the
    // req.dreamerRouteType set above) because doing this to a DYNAMIC
    // request would corrupt the path Next.js's own router needs to see
    // unchanged — appending "index.html" to "/" before it reaches a
    // Lambda-hosted Next.js server breaks its routing outright.
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

app.listen(PORT, () => console.log(`Reverse Proxy Server running on port ${PORT}`))
