const express = require('express')
const httpProxy = require('http-proxy')
const { resolveRoute } = require('./deployment-lookup')
const { recordRequest, startFlushLoop, stopFlushLoop } = require('./metrics-recorder')
const app = express()

const PORT = process.env.PORT || 9000
const BASE_PATH = process.env.BASE_PATH
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'singularitydev.xyz'

const proxy = httpProxy.createProxy()

// Exactly one hop of trust (nginx) so req.ip resolves to the real client
// address instead of the proxy's.
app.set('trust proxy', 1)

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
        // No project/custom-domain with this hostname, or no RUNNING
        // deployment behind it — a legitimate 404, not an error.
        res.status(404).send('No deployment found for this domain')
        return
    }

    // Recorded on 'finish' so statusCode/bytes reflect what the client
    // actually received. Never awaited — a metrics failure must never
    // affect the proxied response.
    const requestStartedAt = process.hrtime.bigint()
    res.once('finish', () => {
        const responseTimeMs = Number(process.hrtime.bigint() - requestStartedAt) / 1_000_000
        const bytesTransferred = Number(res.getHeader('content-length')) || 0
        recordRequest(route.projectId, req.ip, res.statusCode, responseTimeMs, bytesTransferred)
    })

    if (route.type === 'DYNAMIC') {
        if (!route.appUrl) {
            // RUNNING is only ever set AFTER appUrl is persisted — this
            // defends against a half-migrated row rather than proxying to
            // `undefined`.
            res.status(502).send('Deployment is misconfigured (no app container URL)')
            return
        }

        req.dreamerRouteType = 'DYNAMIC'
        proxy.web(req, res, { target: route.appUrl, changeOrigin: true })
        return
    }

    req.dreamerRouteType = 'STATIC'
    // Keyed by route.slug, never hostname — a custom domain's hostname has
    // no relationship to the project slug at all.
    const resolvesTo = `${BASE_PATH}/${route.slug}`
    proxy.web(req, res, { target: resolvesTo, changeOrigin: true })
})

proxy.on('proxyReq', (proxyReq, req, _res) => {
    // MinIO/S3 has no directory-index behavior — "/" must be rewritten to
    // index.html. STATIC only: appending it before a Next.js server would
    // corrupt the path its router needs to see unchanged.
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
    startFlushLoop()
})

// Graceful shutdown gets one last metrics flush; a hard kill -9 still loses
// whatever was buffered (accepted — observability data, not billing-critical).
async function shutdown(signal) {
    console.log(`Received ${signal}, flushing metrics and shutting down`)
    await stopFlushLoop()
    process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
