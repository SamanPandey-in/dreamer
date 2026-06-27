import type { DeploymentLog, DeploymentStatus } from '../generated/prisma/client';

/**
 * Everything published on Redis channel `deployment:{deploymentId}`.
 * build-engine (apps/build-engine/script.js) is the only producer.
 * Three message shapes now share one channel, disambiguated by `type`.
 */
export type DeploymentEvent = DeploymentLogEvent | DeploymentStatusEvent | DeploymentCommitInfoEvent;

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

export function isDeploymentEvent(value: unknown): value is DeploymentEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type: unknown }).type;
  return type === 'log' || type === 'status' || type === 'commit_info';
}
