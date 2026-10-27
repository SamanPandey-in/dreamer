/**
 * Runs `worker(item)` over `items` with at most `limit` in flight at once.
 * A shared cursor feeds `limit` workers, so a slow item never stalls the
 * other slots (unlike fixed-size chunks). Fails fast: the first rejection
 * stops any worker from starting a new item and is rethrown; items already
 * in flight are left to settle on their own.
 */
async function runPool(items, limit, worker) {
    let next = 0
    let aborted = false

    async function lane() {
        while (!aborted && next < items.length) {
            const item = items[next++]
            try {
                await worker(item)
            } catch (error) {
                aborted = true
                throw error
            }
        }
    }

    const lanes = Array.from({ length: Math.min(limit, items.length) }, lane)
    await Promise.all(lanes)
}

module.exports = { runPool }
