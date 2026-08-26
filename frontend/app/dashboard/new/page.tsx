"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { createDeployment, createEnvVariable, createProject, describeApiError } from "@/lib/dashboard-api";
import type { GithubRepoSummary } from "@/lib/dashboard-types";
import { RepoPicker } from "@/components/new-project/RepoPicker";
import { RootDirectoryPicker } from "@/components/new-project/RootDirectoryPicker";
import { BuildConfigForm, type BuildConfigValues } from "@/components/new-project/BuildConfigForm";
import { NewProjectEnvVarsForm, type StagedEnvVar } from "@/components/new-project/NewProjectEnvVarsForm";

type WizardStep =
  | { name: "pick-repo" }
  | { name: "pick-root-directory"; repo: GithubRepoSummary }
  // NEW — `branch` carries whatever the user picked in the Root Directory
  // step's branch dropdown, which may differ from repo.defaultBranch.
  | { name: "configure-build"; repo: GithubRepoSummary; rootDirectory: string; branch: string }
  | {
      name: "env-vars-and-deploy";
      repo: GithubRepoSummary;
      rootDirectory: string;
      buildConfig: BuildConfigValues;
      branch: string;
    };

/**
 * Builds the same https://github.com/owner/repo URL shape createProject's
 * repoUrl field expects, for display/fallback purposes — the authoritative
 * link to a repo is repositoryId (sent alongside this), not repoUrl parsing.
 */
function repoUrlFromFullName(fullName: string): string {
  return `https://github.com/${fullName}`;
}

export default function NewProjectPage() {
  return (
    <Suspense fallback={null}>
      <NewProjectWizard />
    </Suspense>
  );
}

function NewProjectWizard() {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>({ name: "pick-repo" });
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  async function handleDeploy(envVars: StagedEnvVar[]) {
    if (step.name !== "env-vars-and-deploy") return;
    const { repo, rootDirectory, buildConfig, branch } = step;

    setDeploying(true);
    setDeployError(null);

    try {
      // 1. Create the project with the resolved build config — see
      // createProjectSchema on the API for why every one of these fields
      // is accepted at creation time now, not just from Settings afterward.
      // defaultBranch is the branch the user picked in the Root Directory
      // step — not necessarily repo.defaultBranch — since that's the branch
      // this project should actually build and deploy from.
      const project = await createProject({
        name: buildConfig.projectName,
        repoUrl: repoUrlFromFullName(repo.fullName),
        repositoryId: repo.repositoryId,
        defaultBranch: branch,
        isPrivate: repo.isPrivate,
        rootDirectory: rootDirectory || undefined,
        buildCommand: buildConfig.buildCommand || undefined,
        installCommand: buildConfig.installCommand || undefined,
        outputDirectory: buildConfig.outputDirectory || undefined,
        frameworkPresetId: buildConfig.frameworkPresetId,
      });

      // 2. Create each staged env var against the now-real project id.
      // Sequential, not Promise.all — env-variables.service.ts enforces a
      // unique (projectId, key) constraint, and sequential creation gives
      // a clean "variable 3 of 5 failed" error if one key is invalid,
      // rather than a tangle of concurrent rejections to sort through.
      for (const envVar of envVars) {
        await createEnvVariable(project.id, {
          key: envVar.key,
          value: envVar.value,
          environments: envVar.environments,
        });
      }

      // 3. Kick off the first deployment immediately and land on its
      // detail page so the build logs stream in just like the previous
      // wizard flow did before the regression.
      const deployment = await createDeployment(project.id);
      router.push(`/project/${project.id}/deployments/${deployment.id}`);
    } catch (err) {
      setDeployError(describeApiError(err, "Failed to create project. Please try again."));
      setDeploying(false);
    }
  }

  switch (step.name) {
    case "pick-repo":
      return <RepoPicker onSelect={(repo) => setStep({ name: "pick-root-directory", repo })} />;

    case "pick-root-directory":
      return (
        <RootDirectoryPicker
          repoFullName={step.repo.fullName}
          branch={step.repo.defaultBranch}
          onCancel={() => setStep({ name: "pick-repo" })}
          onContinue={(rootDirectory, branch) =>
            setStep({ name: "configure-build", repo: step.repo, rootDirectory, branch })
          }
        />
      );

    case "configure-build":
      return (
        <BuildConfigForm
          repoFullName={step.repo.fullName}
          repoName={step.repo.name}
          branch={step.branch}
          rootDirectory={step.rootDirectory}
          onBack={() => setStep({ name: "pick-root-directory", repo: step.repo })}
          onContinue={(buildConfig) =>
            setStep({
              name: "env-vars-and-deploy",
              repo: step.repo,
              rootDirectory: step.rootDirectory,
              buildConfig,
              branch: step.branch,
            })
          }
        />
      );

    case "env-vars-and-deploy":
      return (
        <NewProjectEnvVarsForm
          deploying={deploying}
          error={deployError}
          onBack={() =>
            setStep({
              name: "configure-build",
              repo: step.repo,
              rootDirectory: step.rootDirectory,
              branch: step.branch,
            })
          }
          onDeploy={handleDeploy}
        />
      );
  }
}
