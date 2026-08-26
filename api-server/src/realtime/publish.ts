import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import type { DeploymentEvent } from './realtime.types';
import { DEPLOYMENT_EVENTS_STREAM_KEY, DEPLOYMENT_EVENTS_STREAM_MAXLEN } from './deployment-events-stream';

/**
 * Routes `status`/`image_ready` through the durable stream — same as
 * build-engine's redis.js does for its own events — so there is exactly one
 * delivery mechanism for "events that change a Deployment row's status";
 * `log`/`commit_info` fall back to plain Pub/Sub (see
 * deployment-events-stream.ts for why that split is fine). log-relay.ts's
 * stream consumer persists the change via transitionDeploymentStatus AND
 * pushes it to sockets, keeping transitionDeploymentStatus's callers to one:
 * log-relay.ts is the sole writer of status changes not originating from a
 * direct user action.
 */
export async function publishDeploymentEvent(deploymentId: string, event: DeploymentEvent): Promise<void> {
  if (event.type === 'status' || event.type === 'image_ready') {
    try {
      await redis.xadd(
        DEPLOYMENT_EVENTS_STREAM_KEY,
        'MAXLEN',
        '~',
        DEPLOYMENT_EVENTS_STREAM_MAXLEN,
        '*',
        'deploymentId',
        deploymentId,
        'payload',
        JSON.stringify(event)
      );
    } catch (err) {
      // Don't let a Redis blip throw out of the caller over a delivery
      // problem — but log loudly: failing to durably record a terminal
      // status may leave the deployment stuck without human help.
      logger.error('Failed to durably persist deployment event to stream', { deploymentId, event, err });
    }
    return;
  }

  await redis.publish(`deployment:${deploymentId}`, JSON.stringify(event));
}
