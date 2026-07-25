import type { DeploymentLog, DeploymentStatus } from '../generated/prisma/client';

/**
 * Everything published on Redis channel `deployment:{deploymentId}`.
 * build-engine (apps/build-engine/script.js) is the only producer.
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
}

/** NEW — reported once, early, independent of whatever status transitions happen around it. */
export interface DeploymentCommitInfoEvent {
  type: 'commit_info';
  commitHash: string;
  commitMessage?: string;
  commitAuthor?: string;
}

/**
 * NEW. Published exactly once per DYNAMIC build, by build-engine's
 * kaniko-build.js, immediately after the built image is successfully
 * pushed to ECR — the hand-off point from "build-engine's job is done"
 * to "api-server now owns turning this image into a live Lambda function."
 * See deployment.service.ts's handleImageReady().
 */
export interface DeploymentImageReadyEvent {
  type: 'image_ready';
  ecrImageUri: string;
  imageSizeBytes?: number;
  /**
   * The PUBLIC url this deployment will be reachable at once the Lambda
   * function is live — computed by build-engine the same way script.js
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
