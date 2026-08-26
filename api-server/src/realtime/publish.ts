import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import type { DeploymentEvent } from './realtime.types';
import { DEPLOYMENT_EVENTS_STREAM_KEY, DEPLOYMENT_EVENTS_STREAM_MAXLEN } from './deployment-events-stream';

/**
 * build.worker.ts's only two call sites are both `status` events (the
 * cancel-while-launching / launch-failed cases) — this always routes
 * `status`/`image_ready` through the durable stream, same as build-engine's
 * redis.js does for its own status/image_ready events, so there's exactly
 * one delivery mechanism for "events that change a Deployment row's
 * status," not two independent ones that happen to agree today. `log`/
 * `commit_info` fall back to the plain Pub/Sub channel — see
 * deployment-events-stream.ts's comment for why that split is fine.
 *
 * log-relay.ts's stream consumer picks these up through a consumer group
 * (XREADGROUP + XACK) — persisted the change via transitionDeploymentStatus
 * AND pushes it to connected sockets — instead of the caller needing its
 * own copy of that logic. Keeps transitionDeploymentStatus's callers to
 * one: log-relay.ts is the sole writer of deployment status changes that
 * originate from something other than a direct user action in
 * deployment.service.ts itself.
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
      // Same reasoning as build-engine's redis.js: don't let a Redis blip
      // throw out of build.worker.ts's job processor over a delivery
      // problem — log it loudly, since this specific failure mode (can't
      // even get the FAILED/CANCELLED/STOPPED event durably recorded)
      // means the deployment may need a human to unstick it.
      logger.error('Failed to durably persist deployment event to stream', { deploymentId, event, err });
    }
    return;
  }

  await redis.publish(`deployment:${deploymentId}`, JSON.stringify(event));
}
