import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { appendLogLine, handleImageReady, recordCommitInfo, transitionDeploymentStatus } from '../deployments/deployment.service';
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
      } else if (event.type === 'image_ready') {
        //  NEW — the DYNAMIC hand-off point. Unlike every other branch
        // here, this one can take 10–60s (Lambda CreateFunction + waiting
        // for State: Active) — deliberately awaited anyway rather than
        // fired-and-forgotten, so a failure inside it still reaches the
        // `catch` below and gets logged, instead of vanishing silently.
        // handleImageReady itself is responsible for emitting the
        // resulting status transition (STARTING -> RUNNING or FAILED) to
        // connected sockets — see its own call to transitionDeploymentStatus.
        const updated = await handleImageReady(deploymentId, event);
        if (updated) {
          io.to(roomFor(deploymentId)).emit('status', { status: updated.status, url: updated.url });
        }
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
