const test = require('node:test')
const assert = require('node:assert/strict')
const { runPool } = require('./run-pool')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('processes every item', async () => {
    const seen = []
    await runPool([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n) })
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5])
})

test('never exceeds the concurrency limit, and reaches it', async () => {
    let active = 0
    let peak = 0
    await runPool(Array.from({ length: 30 }, (_, i) => i), 8, async () => {
        active++
        peak = Math.max(peak, active)
        await sleep(5)
        active--
    })
    assert.equal(peak, 8)
})

test('limit larger than item count works', async () => {
    let count = 0
    await runPool([1, 2], 8, async () => { count++ })
    assert.equal(count, 2)
})

test('empty list resolves', async () => {
    await runPool([], 8, async () => { throw new Error('should not run') })
})

test('first error rejects and no new items start afterward', async () => {
    const started = []
    await assert.rejects(
        runPool([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
            started.push(n)
            await sleep(5)
            if (n === 1) throw new Error('boom')
        }),
        /boom/
    )
    await sleep(30)
    assert.ok(started.length < 8, `expected fail-fast, started ${started.length}`)
})
