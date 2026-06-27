import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { appendLogLine, recordCommitInfo, transitionDeploymentStatus } from '../deployments/deployment.service';
import { env } from '../lib/env';
import { isDeploymentEvent } from './realtime.types';
import { roomFor } from './socket.server';

const CHANNEL_PATTERN = 'deployment:*';

export async function startLogRelay(io: Server): Promise<void> {
  const subscriber = new Redis(env.REDIS_URL);
  await subscriber.psubscribe(CHANNEL_PATTERN);

  subscriber.on('pmessage', async (_pattern: string, channel: string, raw: string) => {
    const deploymentId = channel.slice('deployment:'.length);

    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      console.error('[LOG_RELAY] Non-JSON message on', channel, raw);
      return;
    }

    if (!isDeploymentEvent(event)) {
      console.error('[LOG_RELAY] Unrecognized event shape on', channel, event);
      return;
    }

    try {
      if (event.type === 'log') {
        const log = await appendLogLine(deploymentId, event);
        io.to(roomFor(deploymentId)).emit('log', log);
      } else if (event.type === 'commit_info') {
        //  NEW — metadata only, no status change, nothing to emit to
        // connected sockets for it (the deployment detail page re-fetches
        // on mount; there's no live UI element keyed off commit info today
        // that would need a push).
        await recordCommitInfo(deploymentId, event);
      } else {
        const updated = await transitionDeploymentStatus(deploymentId, event.status, {
          reason: event.reason,
          url: event.url,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          errorStep: event.errorStep,
          uploadedFileCount: event.uploadedFileCount, //  NEW
        });
        if (updated) {
          io.to(roomFor(deploymentId)).emit('status', { status: updated.status, url: updated.url });
        }
      }
    } catch (err) {
      console.error('[LOG_RELAY] Failed to process event for deployment', deploymentId, err);
    }
  });
}
