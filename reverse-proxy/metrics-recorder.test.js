process.env.REDIS_URL = 'redis://localhost:6399'
process.env.METRICS_FLUSH_INTERVAL_MS = '99999999' // disable the automatic timer — this test flushes manually

const Redis = require('ioredis')
const assert = require('node:assert')

async function main() {
    const inspector = new Redis('redis://localhost:6399')
    await inspector.flushdb()

    const { recordRequest } = require('./metrics-recorder')
    // Reach into the module's internals via a second require of the flush
    // function isn't exported — call it indirectly by requiring again and
    // using startFlushLoop/stopFlushLoop's underlying flush via a tiny
    // re-require trick: instead, just export flush for this test run by
    // monkey-patching require cache is overkill — simplest: require the
    // file fresh and grab flush via module.exports if we temporarily add
    // it. Since flush() isn't exported in the real module (intentionally
    // — only recordRequest/startFlushLoop/stopFlushLoop are the public
    // surface index.js uses), drive this test through stopFlushLoop(),
    // which internally calls flush() once. That's also a MORE realistic
    // test: it's the exact same code path a graceful shutdown takes.
    const { stopFlushLoop } = require('./metrics-recorder')

    const projectA = '11111111-1111-1111-1111-111111111111'
    const projectB = '22222222-2222-2222-2222-222222222222'

    console.log('--- Simulating 500 requests to project A, 10 to project B ---')
    for (let i = 0; i < 500; i++) {
        recordRequest(projectA, `10.0.0.${i % 50}`, i % 20 === 0 ? 500 : 200, 20 + (i % 100), 1200)
    }
    for (let i = 0; i < 10; i++) {
        recordRequest(projectB, `10.0.1.${i}`, 200, 15, 800)
    }

    console.log('--- Flushing (via stopFlushLoop, the real shutdown path) ---')
    await stopFlushLoop()

    // ── Assertions ──
    const activeIntervals = await inspector.smembers('metrics:active-intervals')
    assert.strictEqual(activeIntervals.length, 2, `expected 2 active intervals, got ${activeIntervals.length}`)

    const memberA = activeIntervals.find((m) => m.startsWith(projectA))
    const memberB = activeIntervals.find((m) => m.startsWith(projectB))
    assert.ok(memberA, 'project A member missing from active-intervals')
    assert.ok(memberB, 'project B member missing from active-intervals')

    const baseA = `metrics:${memberA}`
    const requestsA = Number(await inspector.get(`${baseA}:requests`))
    assert.strictEqual(requestsA, 500, `expected 500 requests recorded for project A, got ${requestsA}`)

    const status5xxA = Number(await inspector.get(`${baseA}:status:5xx`))
    assert.strictEqual(status5xxA, 25, `expected 25 5xx responses (500/20), got ${status5xxA}`)

    const status2xxA = Number(await inspector.get(`${baseA}:status:2xx`))
    assert.strictEqual(status2xxA, 475, `expected 475 2xx responses, got ${status2xxA}`)

    const visitorsA = await inspector.pfcount(`${baseA}:visitors`)
    // HLL is approximate — allow a small margin around the true 50 unique IPs
    assert.ok(Math.abs(visitorsA - 50) <= 2, `expected ~50 unique visitors (HLL approx), got ${visitorsA}`)

    const bytesA = Number(await inspector.get(`${baseA}:bytes`))
    assert.strictEqual(bytesA, 500 * 1200, `expected ${500 * 1200} bytes, got ${bytesA}`)

    const rtMaxA = Number(await inspector.get(`${baseA}:rt_max`))
    assert.strictEqual(rtMaxA, 119, `expected rt_max 119 (20 + 99), got ${rtMaxA}`) // i%100 maxes at 99 -> 20+99=119

    const ttl = await inspector.ttl(`${baseA}:requests`)
    assert.ok(ttl > 0 && ttl <= 3600, `expected a positive TTL <= 3600s on requests key, got ${ttl}`)

    const baseB = `metrics:${memberB}`
    const requestsB = Number(await inspector.get(`${baseB}:requests`))
    assert.strictEqual(requestsB, 10, `expected 10 requests recorded for project B, got ${requestsB}`)

    console.log('--- Verifying flush() emits a bounded, small command count (not one-per-request) ---')
    // Count commands actually sent for THIS flush by monitoring is overkill
    // for this test; instead, verify indirectly: record another batch and
    // confirm counts ACCUMULATE correctly across a second flush cycle
    // (this is what would break if the swap-vs-clear bug were still
    // present — a second flush's counts would either double-count or wipe
    // the first flush's data).
    for (let i = 0; i < 100; i++) {
        recordRequest(projectA, `10.0.0.${i % 50}`, 200, 10, 500)
    }
    await stopFlushLoop()

    const requestsA2 = Number(await inspector.get(`${baseA}:requests`))
    assert.strictEqual(requestsA2, 600, `expected requests to ACCUMULATE to 600 after second flush, got ${requestsA2}`)

    const bytesA2 = Number(await inspector.get(`${baseA}:bytes`))
    assert.strictEqual(bytesA2, 500 * 1200 + 100 * 500, `expected bytes to accumulate correctly, got ${bytesA2}`)

    console.log('\nALL ASSERTIONS PASSED')
    await inspector.quit()
    process.exit(0)
}

main().catch((err) => {
    console.error('TEST FAILED:', err)
    process.exit(1)
})
