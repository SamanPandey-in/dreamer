import { apiFetch } from "./api-client";
import type {
  Deployment,
  DeploymentDetail,
  DeploymentStatus,
  EnvVariable,
  EnvironmentTarget,
  LogLine,
  Project,
  ProjectWithLatestDeployment,
} from "./dashboard-types";

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? "Something went wrong. Please try again.");
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
