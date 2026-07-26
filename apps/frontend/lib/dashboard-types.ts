// Mirrors src/generated/prisma/enums.ts's DeploymentStatus on the API —
// keep in sync if the schema's enum ever changes.
export type DeploymentStatus =
  | "QUEUED"
  | "BUILDING"
  | "UPLOADING"
  | "STARTING"
  | "RUNNING"
  | "SLEEPING"
  | "WAKING"
  | "STOPPED"
  | "FAILED"
  | "CANCELLED"
  | "ERROR";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG" | "SYSTEM";

// Mirrors EnvironmentTarget from the API's generated Prisma enums.
export type EnvironmentTarget = "PRODUCTION" | "PREVIEW" | "DEVELOPMENT";

// Mirrors Framework from the API's generated Prisma enums.
export type Framework =
  | "REACT_CRA"
  | "REACT_VITE"
  | "VUE"
  | "SVELTE"
  | "NEXT_STATIC"
  | "NEXT_SSR"
  | "EXPRESS"
  | "FASTIFY"
  | "HONO"
  | "STATIC_HTML"
  | "UNKNOWN";

export type DeploymentType = "STATIC" | "DYNAMIC";

// Mirrors PublicProject from the API's src/projects/project.types.ts.
export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  repoUrl: string;
  repoFullName: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  activeDeploymentId: string | null;
  lastDeployedAt: string | null;
  createdAt: string;
  buildCommand: string | null;
  installCommand: string | null;
  outputDirectory: string | null;
  rootDirectory: string | null;
  // NEW — read-only labels of what the new-project wizard detected at
  // creation time. See the build-config detection guide.
  detectedFramework: Framework | null;
  detectedDeploymentType: DeploymentType | null;
  autoDeployEnabled: boolean;
}

// Mirrors LatestDeploymentSummary from project.types.ts.
export interface LatestDeploymentSummary {
  id: string;
  slug: string;
  status: DeploymentStatus;
  url: string | null;
  branch: string;
  commitMessage: string | null;
  createdAt: string;
}

// Mirrors ProjectWithLatestDeployment from project.types.ts.
export interface ProjectWithLatestDeployment extends Project {
  deploymentCount: number;
  latestDeployment: LatestDeploymentSummary | null;
}

// Mirrors PublicDeployment from the API's src/deployments/deployment.types.ts.
export interface Deployment {
  id: string;
  projectId: string;
  slug: string;
  status: DeploymentStatus;
  type: "STATIC" | "DYNAMIC" | null;
  framework: string | null;
  branch: string;
  commitHash: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  url: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  errorStep: string | null;
  buildDurationMs: number | null;
  uploadedFileCount: number | null;
  imageSizeBytes: number | null;
  environment: EnvironmentTarget;
  deployedById: string | null;
  triggeredBy: string;
  queuedAt: string;
  buildStartedAt: string | null;
  buildFinishedAt: string | null;
  deployedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
}

// Mirrors PublicStateTransition.
export interface StateTransition {
  id: string;
  fromStatus: DeploymentStatus | null;
  toStatus: DeploymentStatus;
  reason: string | null;
  createdAt: string;
}

export interface DeploymentDetail extends Deployment {
  stateTransitions: StateTransition[];
}

// Mirrors PublicLogLine.
export interface LogLine {
  id: string;
  level: LogLevel;
  message: string;
  sequence: number;
  source: string | null;
  timestamp: string;
}

// Mirrors PublicEnvVariable from the API's src/env-variables/env-variables.types.ts.
export interface EnvVariable {
  id: string;
  projectId: string;
  key: string;
  value: string | null;
  maskedValue: string;
  isSecret: boolean;
  environments: EnvironmentTarget[];
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export const ACTIVE_STATUSES: DeploymentStatus[] = ["QUEUED", "BUILDING", "UPLOADING", "STARTING"];
export const TERMINAL_STATUSES: DeploymentStatus[] = ["RUNNING", "STOPPED", "FAILED", "CANCELLED"];

// Mirrors deployment.service.ts's NON_STOPPABLE_STATUSES exactly.
export const NON_STOPPABLE_STATUSES: DeploymentStatus[] = ["STOPPED", "FAILED", "CANCELLED"];

// Mirrors deployment.service.ts's ROLLBACK_TARGET_STATUSES.
export const ROLLBACK_TARGET_STATUSES: DeploymentStatus[] = ["RUNNING", "STOPPED"];

// ---------------------------------------------------------------------------
// New-project wizard types
// ---------------------------------------------------------------------------

// Mirrors RepoEntry from the API's src/integrations/github-repo.service.ts.
export interface RepoEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

// Mirrors UserRepoSummary from the API's src/integrations/github-repo.service.ts.
export interface UserRepoSummary {
  fullName: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  updatedAt: string;
}

// Mirrors RepoBranch from the API's src/integrations/github-repo.service.ts.
export interface RepoBranch {
  name: string;
  isDefault: boolean;
}

// Mirrors FrameworkPresetId from the API's src/build-config/framework-presets.ts.
// Kept as a plain string union here (not imported — the frontend has no
// access to the API's TS source) so adding a new preset on the backend
// only breaks this file's type-checking if the frontend genuinely needs to
// know about it (e.g. to render a distinct icon), rather than silently
// becoming "any string is valid" the way an un-typed string would.
export type FrameworkPresetId =
  | "nextjs-static"
  | "nextjs-ssr"
  | "vite"
  | "cra"
  | "angular"
  | "gatsby"
  | "sveltekit"
  | "astro"
  | "nuxt"
  | "vue-cli"
  | "static";

// Mirrors DetectedBuildConfig from the API's src/build-config/build-config.types.ts.
export interface DetectedBuildConfig {
  framework: {
    id: FrameworkPresetId;
    label: string;
    deploymentType: DeploymentType;
    requiresUnsupportedRuntime: boolean;
  };
  matchedOn: string | null;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
}

// Mirrors PublicFrameworkPreset from the API's src/build-config/framework-presets.ts.
export interface PublicFrameworkPreset {
  id: FrameworkPresetId;
  label: string;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
}
