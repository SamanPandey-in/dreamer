const Redis = require('ioredis')

const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

// Same channel carries both log lines and status events — api-server's
// src/realtime/log-relay.ts tells them apart by `type`. Keep this contract
// in sync BY HAND with src/realtime/realtime.types.ts on the API server —
// there's no shared package between this app (plain Node) and that one
// (TypeScript) to enforce it for you.
const CHANNEL = `deployment:${process.env.DEPLOYMENT_ID}`

function publishLog(message, level = 'INFO', source = 'build') {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'log', level, message, source }))
}

function publishStatus(status, extra = {}) {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'status', status, ...extra }))
}

// NEW — a distinct message type, not folded into a status event, because
// it isn't one: api-server's log-relay.ts (Part 2 §2 below) routes this to
// deployment.service.ts's recordCommitInfo(), which touches three metadata
// columns and zero status columns.
function publishCommitInfo(commitInfo) {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'commit_info', ...commitInfo }))
}

module.exports = {
    publishLog,
    publishStatus,
    publishCommitInfo,
    publisher
}