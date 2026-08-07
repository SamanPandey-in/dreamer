import { apiFetch } from "./api-client";
import { ApiError, extractRequestId } from "./api-error";
export { ApiError, describeApiError, getErrorRequestId } from "./api-error";
import type {
  Deployment,
  DeploymentDetail,
  DeploymentStatus,
  DetectedBuildConfig, // NEW
  EnvVariable,
  EnvironmentTarget,
  FrameworkPresetId, // NEW
  LogLine,
  Project,
  ProjectWithLatestDeployment,
  PublicFrameworkPreset, // NEW
  RepoBranch, // NEW
  RepoEntry, // NEW
  UserRepoSummary, // NEW
} from "./dashboard-types";

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(data?.error ?? "Something went wrong. Please try again.", data?.code, extractRequestId(data, res));
  }
  return data as T;
}

// Projects

export async function listProjects(): Promise<ProjectWithLatestDeployment[]> {
  const res = await apiFetch("/api/projects");
  const data = await parseJson<{ projects: ProjectWithLatestDeployment[] }>(res);
  return data.projects;
}

export interface CreateProjectInput {
  name: string;
  repoUrl: string;
  defaultBranch?: string;
  description?: string;
  isPrivate?: boolean;
  // NEW — set by the new-project wizard after the root-directory and
  // build-config steps. See createProjectSchema on the API for the
  // authoritative shape this mirrors.
  rootDirectory?: string;
  buildCommand?: string;
  installCommand?: string;
  outputDirectory?: string;
  frameworkPresetId?: FrameworkPresetId;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const res = await apiFetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

export async function getProject(projectId: string): Promise<Project> {
  const res = await apiFetch(`/api/projects/${projectId}`);
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  defaultBranch?: string;
  buildCommand?: string;
  installCommand?: string;
  outputDirectory?: string;
  rootDirectory?: string;
  autoDeployEnabled?: boolean;
}

export async function updateProject(projectId: string, input: UpdateProjectInput): Promise<Project> {
  const res = await apiFetch(`/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

export async function deleteProject(projectId: string): Promise<void> {
  const res = await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to delete project. Please try again.");
  }
}

// New-project wizard

/** Lists the authenticated user's own GitHub repos — the wizard's "Import Git Repository" step (1). */
export async function listUserRepos(): Promise<UserRepoSummary[]> {
  const res = await apiFetch("/api/github/repos");
  const data = await parseJson<{ repos: UserRepoSummary[] }>(res);
  return data.repos;
}

/**
 * Lists one directory level of a GitHub repo — used by the wizard's
 * root-directory picker, called once per expanded folder rather than
 * recursively, mirroring how the API's listRepoDirectory itself only
 * fetches one level at a time.
 */
export async function listGithubRepoContents(
  repoFullName: string,
  branch: string,
  path = ""
): Promise<RepoEntry[]> {
  const params = new URLSearchParams({ repoFullName, branch, path });
  const res = await apiFetch(`/api/github/repo-contents?${params}`);
  const data = await parseJson<{ entries: RepoEntry[] }>(res);
  return data.entries;
}

/**
 * Searches public GitHub repos by name — backs the wizard's "any other
 * publicly available GitHub repo" search bar, which sits above the "Your
 * Repositories" list and follows the same fullName-based selection flow
 * once a result is chosen.
 */
export async function searchPublicRepos(query: string): Promise<UserRepoSummary[]> {
  const params = new URLSearchParams({ query });
  const res = await apiFetch(`/api/github/public-repos?${params}`);
  const data = await parseJson<{ repos: UserRepoSummary[] }>(res);
  return data.repos;
}

/**
 * Lists a repo's branches, default branch flagged — shared by the wizard's
 * branch picker and the project-settings "Production Branch" dropdown.
 */
export async function listRepoBranches(repoFullName: string, defaultBranch: string): Promise<RepoBranch[]> {
  const params = new URLSearchParams({ repoFullName, defaultBranch });
  const res = await apiFetch(`/api/github/branches?${params}`);
  const data = await parseJson<{ branches: RepoBranch[] }>(res);
  return data.branches;
}

/**
 * Lists every framework preset and its default install/build/output
 * commands — fetched once when the wizard mounts, used both to populate
 * the "Application Preset" dropdown's options and to re-fill the build
 * config fields when the user manually picks a different preset than
 * what /detect returned (a local, instant UI action — no need to re-hit
 * GitHub for that).
 */
export async function listFrameworkPresets(): Promise<PublicFrameworkPreset[]> {
  const res = await apiFetch("/api/build-config/presets");
  const data = await parseJson<{ presets: PublicFrameworkPreset[] }>(res);
  return data.presets;
}

/**
 * Resolves the framework/build-config detection for a chosen root
 * directory — called right after the user confirms that step in the
 * wizard. See build-config.service.ts on the API for what this actually
 * inspects (config files, package.json dependencies, lockfiles).
 */
export async function detectBuildConfig(
  repoFullName: string,
  branch: string,
  rootDirectory: string
): Promise<DetectedBuildConfig> {
  const res = await apiFetch("/api/build-config/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoFullName, branch, rootDirectory }),
  });
  const data = await parseJson<{ detected: DetectedBuildConfig }>(res);
  return data.detected;
}

// Deployments

export async function createDeployment(projectId: string, branch?: string): Promise<Deployment> {
  const res = await apiFetch(`/api/projects/${projectId}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(branch ? { branch } : {}),
  });
  const data = await parseJson<{ deployment: Deployment }>(res);
  return data.deployment;
}

export async function listDeployments(
  projectId: string,
  opts: {
    cursor?: string;
    limit?: number;
    branch?: string;
    status?: DeploymentStatus;
    environment?: "PRODUCTION" | "PREVIEW";
    dateFrom?: string;
    dateTo?: string;
  } = {}
): Promise<{ deployments: Deployment[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.branch) params.set("branch", opts.branch);
  if (opts.status) params.set("status", opts.status);
  if (opts.environment) params.set("environment", opts.environment);
  if (opts.dateFrom) params.set("dateFrom", opts.dateFrom);
  if (opts.dateTo) params.set("dateTo", opts.dateTo);

  const res = await apiFetch(`/api/projects/${projectId}/deployments?${params}`);
  return parseJson(res);
}

export async function getDeployment(deploymentId: string): Promise<DeploymentDetail> {
  const res = await apiFetch(`/api/deployments/${deploymentId}`);
  const data = await parseJson<{ deployment: DeploymentDetail }>(res);
  return data.deployment;
}

export async function getDeploymentLogs(deploymentId: string, after = 0, limit = 500): Promise<LogLine[]> {
  const res = await apiFetch(`/api/deployments/${deploymentId}/logs?after=${after}&limit=${limit}`);
  const data = await parseJson<{ logs: LogLine[] }>(res);
  return data.logs;
}

export async function rollbackDeployment(deploymentId: string): Promise<Deployment> {
  const res = await apiFetch(`/api/deployments/${deploymentId}/rollback`, { method: "POST" });
  const data = await parseJson<{ deployment: Deployment }>(res);
  return data.deployment;
}

export async function stopDeployment(deploymentId: string): Promise<Deployment> {
  const res = await apiFetch(`/api/deployments/${deploymentId}/stop`, { method: "POST" });
  const data = await parseJson<{ deployment: Deployment }>(res);
  return data.deployment;
}

// Environment Variables

export interface EnvVariableInput {
  key: string;
  value: string;
  environments: EnvironmentTarget[];
  isSecret?: boolean;
  description?: string;
}

export async function listEnvVariables(projectId: string): Promise<EnvVariable[]> {
  const res = await apiFetch(`/api/projects/${projectId}/env-variables`);
  const data = await parseJson<{ envVariables: EnvVariable[] }>(res);
  return data.envVariables;
}

export async function createEnvVariable(projectId: string, input: EnvVariableInput): Promise<EnvVariable> {
  const res = await apiFetch(`/api/projects/${projectId}/env-variables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJson<{ envVariable: EnvVariable }>(res);
  return data.envVariable;
}

export async function updateEnvVariable(
  envVariableId: string,
  input: Partial<EnvVariableInput>
): Promise<EnvVariable> {
  const res = await apiFetch(`/api/env-variables/${envVariableId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseJson<{ envVariable: EnvVariable }>(res);
  return data.envVariable;
}

export async function deleteEnvVariable(envVariableId: string): Promise<void> {
  const res = await apiFetch(`/api/env-variables/${envVariableId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to delete environment variable. Please try again.");
  }
}

export async function revealEnvVariable(envVariableId: string): Promise<string> {
  const res = await apiFetch(`/api/env-variables/${envVariableId}/reveal`, { method: "POST" });
  const data = await parseJson<{ value: string }>(res);
  return data.value;
}
