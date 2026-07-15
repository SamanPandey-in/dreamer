"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createEnvVariable, createProject } from "@/lib/dashboard-api";
import type { UserRepoSummary } from "@/lib/dashboard-types";
import { RepoPicker } from "@/components/new-project/RepoPicker";
import { RootDirectoryPicker } from "@/components/new-project/RootDirectoryPicker";
import { BuildConfigForm, type BuildConfigValues } from "@/components/new-project/BuildConfigForm";
import { NewProjectEnvVarsForm, type StagedEnvVar } from "@/components/new-project/NewProjectEnvVarsForm";

type WizardStep =
  | { name: "pick-repo" }
  | { name: "pick-root-directory"; repo: UserRepoSummary }
  | { name: "configure-build"; repo: UserRepoSummary; rootDirectory: string }
  | { name: "env-vars-and-deploy"; repo: UserRepoSummary; rootDirectory: string; buildConfig: BuildConfigValues };

/**
 * Builds the same https://github.com/owner/repo URL shape createProject's
 * own repoUrl field expects — UserRepoSummary only carries `fullName`
 * ("owner/repo") since that's all the GitHub API calls the wizard makes
 * need, but project.service.ts's parseRepoFullName regex specifically
 * matches a full github.com URL, not a bare "owner/repo" string.
 */
function repoUrlFromFullName(fullName: string): string {
  return `https://github.com/${fullName}`;
}

export default function NewProjectPage() {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>({ name: "pick-repo" });
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  async function handleDeploy(envVars: StagedEnvVar[]) {
    if (step.name !== "env-vars-and-deploy") return;
    const { repo, rootDirectory, buildConfig } = step;

    setDeploying(true);
    setDeployError(null);

    try {
      // 1. Create the project with the resolved build config — see
      // createProjectSchema on the API for why every one of these fields
      // is accepted at creation time now, not just from Settings afterward.
      const project = await createProject({
        name: buildConfig.projectName,
        repoUrl: repoUrlFromFullName(repo.fullName),
        defaultBranch: repo.defaultBranch,
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

      // 3. Land on the project overview — NOT a deployment detail page.
      // createProject alone doesn't trigger a deployment (that's a
      // separate POST the project page's own "Deploy" action already
      // handles) — see project.controller.ts's createProjectHandler.
      router.push(`/project/${project.id}`);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : "Failed to create project. Please try again.");
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
          onContinue={(rootDirectory) =>
            setStep({ name: "configure-build", repo: step.repo, rootDirectory })
          }
        />
      );

    case "configure-build":
      return (
        <BuildConfigForm
          repoFullName={step.repo.fullName}
          repoName={step.repo.name}
          branch={step.repo.defaultBranch}
          rootDirectory={step.rootDirectory}
          onBack={() => setStep({ name: "pick-root-directory", repo: step.repo })}
          onContinue={(buildConfig) =>
            setStep({
              name: "env-vars-and-deploy",
              repo: step.repo,
              rootDirectory: step.rootDirectory,
              buildConfig,
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
            setStep({ name: "configure-build", repo: step.repo, rootDirectory: step.rootDirectory })
          }
          onDeploy={handleDeploy}
        />
      );
  }
}
