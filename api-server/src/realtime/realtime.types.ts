import type { DeploymentLog, DeploymentStatus } from '../generated/prisma/client';

/**
 * Everything published on Redis channel `deployment:{deploymentId}`.
 * build-engine (apps/build-engine/script.js) is the primary producer for
 * the whole build/run lifecycle. build.worker.ts is now also a producer,
 * but ONLY for the narrow case where a deployment gets cancelled while
 * LAUNCHING — see its cancelRequested handling — so that this stays the
 * single path anything writes a status change through, instead of
 * build.worker.ts needing its own duplicate "update DB + push to sockets"
 * logic.
 * Four message shapes now share one channel, disambiguated by `type`.
 */
export type DeploymentEvent = DeploymentLogEvent | DeploymentStatusEvent | DeploymentCommitInfoEvent | DeploymentImageReadyEvent;

export interface DeploymentLogEvent {
  type: 'log';
  level: DeploymentLog['level'];
  message: string;
  source?: string;
}

export interface DeploymentStatusEvent {
  type: 'status';
  status: DeploymentStatus;
  reason?: string;
  url?: string;
  errorCode?: string;
  errorMessage?: string;
  errorStep?: string;
  /**  NEW — only ever sent alongside the RUNNING transition for a static build; see script.js. */
  uploadedFileCount?: number;
  /**
   * NEW — who/what caused this transition. transitionDeploymentStatus()
   * defaults to 'build-engine' when this is omitted, which stays correct
   * for the vast majority of events (build-engine really is the only
   * producer for those). build.worker.ts sets this explicitly ('user') for
   * the late-cancel event it publishes, so the audit trail
   * (DeploymentStateTransition) attributes it correctly instead of
   * claiming build-engine did it.
   */
  triggeredBy?: string;
}

/** NEW — reported once, early, independent of whatever status transitions happen around it. */
export interface DeploymentCommitInfoEvent {
  type: 'commit_info';
  commitHash: string;
  commitMessage?: string;
  commitAuthor?: string;
}

/**
 * Published exactly once per DYNAMIC build, by build-engine's
 * docker-build.js, immediately after the image finishes building locally
 * — the hand-off point from "build-engine's job is done" to "api-server
 * now owns turning this image into a live running container." See
 * deployment.service.ts's handleImageReady().
 */
export interface DeploymentImageReadyEvent {
  type: 'image_ready';
  imageUri: string;
  imageSizeBytes?: number;
  /**
   * The PUBLIC url this deployment will be reachable at once the app
   * container is live — computed by build-engine the same way script.js
   * already computes it for a STATIC deployment's RUNNING event
   * (`https://{PROJECT_SLUG}.{BASE_DOMAIN}`), so api-server doesn't need
   * its own copy of BASE_DOMAIN just to reconstruct it.
   */
  url: string;
}

export function isDeploymentEvent(value: unknown): value is DeploymentEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type: unknown }).type;
  return type === 'log' || type === 'status' || type === 'commit_info' || type === 'image_ready';
}
