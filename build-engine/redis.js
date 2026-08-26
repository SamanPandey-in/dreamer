const Redis = require('ioredis')

const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

// One channel carries logs + status + metadata events, distinguished by
// `type`. Contract is kept in sync BY HAND with api-server's
// src/realtime/realtime.types.ts — no shared package enforces it.
const CHANNEL = `deployment:${process.env.DEPLOYMENT_ID}`

function publishLog(message, level = 'INFO', source = 'build') {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'log', level, message, source }))
}

function publishStatus(status, extra = {}) {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'status', status, ...extra }))
}

function publishCommitInfo(commitInfo) {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'commit_info', ...commitInfo }))
}

// DYNAMIC hand-off: publishing image_ready is what makes api-server start
// the app container. That happens THERE, not here — a compromised build
// container should never be able to start/stop arbitrary host containers.
function publishImageReady(imageInfo) {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'image_ready', ...imageInfo }))
}

module.exports = {
    publishLog,
    publishStatus,
    publishCommitInfo,
    publishImageReady,
    publisher
}