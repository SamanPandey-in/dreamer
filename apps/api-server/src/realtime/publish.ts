import { redis } from '../lib/redis';
import type { DeploymentEvent } from './realtime.types';

/**
 * Publishes onto the exact same `deployment:{deploymentId}` channel
 * build-engine's script.js uses. log-relay.ts (already subscribed to
 * `deployment:*`) picks it up through the SAME path as every other
 * log/status event — persists the change via transitionDeploymentStatus
 * AND pushes it to connected sockets — instead of the caller needing its
 * own copy of that logic. Keeps transitionDeploymentStatus's callers to
 * one: log-relay.ts is the sole writer of deployment status changes that
 * originate from something other than a direct user action in
 * deployment.service.ts itself.
 */
export async function publishDeploymentEvent(deploymentId: string, event: DeploymentEvent): Promise<void> {
  await redis.publish(`deployment:${deploymentId}`, JSON.stringify(event));
}
