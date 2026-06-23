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

module.exports = {
    publishLog,
    publishStatus,
    publisher
}