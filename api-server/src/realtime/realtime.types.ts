import type { DeploymentLog, DeploymentStatus } from '../generated/prisma/client';

/**
 * Everything published on Redis channel `deployment:{deploymentId}` — four
 * message shapes sharing one channel, disambiguated by `type`. build-engine's
 * script.js is the primary producer for the whole build/run lifecycle;
 * publish.ts/build.worker.ts add only the narrow late-cancel `status` case,
 * so status changes keep a single write path (update DB + push to sockets)
 * instead of duplicating it.
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
  /** Only sent alongside RUNNING for a static build; see script.js. */
  uploadedFileCount?: number;
  /**
   * Who/what caused this transition. transitionDeploymentStatus() defaults
   * to 'build-engine' when omitted (correct for the vast majority of
   * events); set explicitly ('user') for events from other sources so the
   * audit trail (DeploymentStateTransition) attributes them correctly.
   */
  triggeredBy?: string;
}

/** Reported once, early, independent of whatever status transitions happen around it. */
export interface DeploymentCommitInfoEvent {
  type: 'commit_info';
  commitHash: string;
  commitMessage?: string;
  commitAuthor?: string;
}

/**
 * Published exactly once per DYNAMIC build, by build-engine's
 * docker-build.js, immediately after the image finishes building locally —
 * the hand-off point from "build-engine's job is done" to "api-server now
 * owns turning this image into a live running container." See
 * deployment.service.ts's handleImageReady().
 */
export interface DeploymentImageReadyEvent {
  type: 'image_ready';
  imageUri: string;
  imageSizeBytes?: number;
  /**
   * The PUBLIC url this deployment will be reachable at once the app
   * container is live — computed by build-engine the same way script.js
   * already computes it for a STATIC deployment's RUNNING event, so
   * api-server doesn't need its own copy of BASE_DOMAIN just to reconstruct it.
   */
  url: string;
}

export function isDeploymentEvent(value: unknown): value is DeploymentEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type: unknown }).type;
  return type === 'log' || type === 'status' || type === 'commit_info' || type === 'image_ready';
}
