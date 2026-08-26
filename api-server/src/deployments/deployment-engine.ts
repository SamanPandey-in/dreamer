import { env } from '../lib/env';
import { dockerRun, dockerRemove, dockerInspectId, dockerRename, waitForHttpReady } from '../lib/docker-engine';

/**
 * Everything deployment.service.ts needs from "whatever actually runs the
 * build" — Dependency Inversion: the high-level module depends on this
 * abstraction; DockerDeploymentEngine implements it. Only one implementation
 * exists — the abstraction is kept because deployment.service.ts is written
 * against it.
 */
export interface DeploymentEngine {
  /**
   * `gitAccessToken` is a separate argument, not part of `job`, on purpose —
   * `job` (BuildJob) is exactly what's stored as BullMQ job data in Redis;
   * the decrypted token must never join that persisted payload. Resolved in
   * build.worker.ts immediately before this call.
   */
  launchBuildTask(job: BuildJob, gitAccessToken?: string): Promise<EngineHandle>;

  /**
   * Stops an in-flight build container. Idempotent — calling it on a
   * container that already exited no-ops rather than throws — so
   * stopDeployment() may call it speculatively without re-checking Docker's
   * live state.
   */
  stopBuildTask(buildContainerId: string): Promise<void>;

  /**
   * Takes a DYNAMIC deployment's freshly-built local image (build-engine's
   * docker-build.js) and turns it into a live, publicly reachable container.
   * Called from deployment.service.ts's handleImageReady() — the handler for
   * the `image_ready` event published once the `docker build` step finishes
   * (see realtime.types.ts).
   *
   * One container per PROJECT: a redeploy replaces the running container via
   * a health-checked staged swap, not stop-then-start (mirrors STATIC
   * sharing one output prefix per project).
   */
  deployDynamicApp(job: DynamicDeployJob): Promise<EngineDynamicHandle>;

  /**
   * Tears down a DYNAMIC deployment's app container. Safely callable even if
   * the container is already gone (a raced redeploy replaced it, or a
   * double-clicked Stop) — dockerRemove() swallows "no such container".
   */
  stopDynamicApp(appContainerName: string): Promise<void>;
}

export interface BuildJob {
  deploymentId: string;
  projectSlug: string;
  projectId: string;
  repoUrl: string;
  branch: string;
  /** Set only by rollbackDeployment. Pins the build to this exact commit instead of the branch's current HEAD; see clone-repo.js's runCheckoutIfPinned. */
  commitHash?: string;
  // Single operator-wide PAT model: `isPrivate` is all this job needs to
  // know — build.worker.ts decrypts the PAT (lib/git-credentials.ts) right
  // before the launchBuildTask call that needs it; the token never enters
  // this persisted payload.
  isPrivate: boolean;
  // Build config from the Project row. null on any field means build-engine
  // falls back to its own default for that field (script.js's
  // INSTALL_COMMAND/BUILD_COMMAND/OUTPUT_DIRECTORY fallbacks).
  rootDirectory: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  /**
   * Decrypted project env vars scoped to this deployment's environment,
   * resolved by deployment.service.ts right before launchBuildTask and
   * forwarded into the build container's own environment.
   */
  userEnvVars: Array<{ name: string; value: string }>;
  /**
   * Forwarded as the DEPLOYMENT_TYPE container env var — the ONLY thing that
   * decides whether build-engine's script.js takes the static-upload branch
   * or the local-docker-build branch after the build finishes. Straight off
   * Project.detectedDeploymentType.
   */
  deploymentType: 'STATIC' | 'DYNAMIC' | null;
  /**
   * Forwarded as FRAMEWORK. Used by build-engine's dockerfile-resolver.js
   * to pick the right Dockerfile template (NEXT_SSR → the Next.js
   * standalone template; see dockerfile-templates/).
   */
  framework: string | null;
}

export interface EngineHandle {
  buildContainerId: string;
}

/** What deployDynamicApp needs to build/run the app container. */
export interface DynamicDeployJob {
  deploymentId: string;
  /** Project slug, NOT deployment slug — the app container is keyed per-project. */
  projectSlug: string;
  /** The local image tag build-engine's docker-build.js just built, e.g. "dreamer-app:my-project". */
  imageUri: string;
  userEnvVars: Array<{ name: string; value: string }>;
}

/** What deployDynamicApp hands back for deployment.service.ts to persist on the Deployment row. */
export interface EngineDynamicHandle {
  appContainerId: string;
  appContainerName: string;
  appUrl: string;
}

/**
 * The one and only DeploymentEngine implementation — shells out to the
 * `docker` CLI via lib/docker-engine.ts for both build containers and
 * running app containers.
 */
export class DockerDeploymentEngine implements DeploymentEngine {
  private buildContainerNameFor(deploymentId: string): string {
    return `dreamer-build-${deploymentId}`;
  }

  private appContainerNameFor(projectSlug: string): string {
    return `dreamer-app-${projectSlug}`;
  }

  async launchBuildTask(job: BuildJob, gitAccessToken?: string): Promise<EngineHandle> {
    const containerName = this.buildContainerNameFor(job.deploymentId);

    // Every one of these becomes a container env var build-engine's
    // script.js reads by name — see that file for the read side.
    // REDIS_URL (not REDIS_BUILDER_URL) on purpose: build-engine's own
    // pub/sub logging is a general-Redis concern, not a BullMQ one.
    const envVars: Record<string, string> = {
      REDIS_URL: env.REDIS_URL,
      GIT_REPOSITORY_URL: job.repoUrl,
      BRANCH: job.branch,
      DEPLOYMENT_ID: job.deploymentId,
      PROJECT_SLUG: job.projectSlug,
      ...(job.commitHash ? { COMMIT_HASH: job.commitHash } : {}),
      ...(gitAccessToken ? { GIT_ACCESS_TOKEN: gitAccessToken } : {}),
      ROOT_DIRECTORY: job.rootDirectory ?? '',
      INSTALL_COMMAND: job.installCommand ?? '',
      BUILD_COMMAND: job.buildCommand ?? '',
      OUTPUT_DIRECTORY: job.outputDirectory ?? '',
      DEPLOYMENT_TYPE: job.deploymentType ?? 'STATIC',
      FRAMEWORK: job.framework ?? '',
      // MinIO — forwarded from this process's own resolved env so
      // build-engine's S3 client talks to the same bucket with no second
      // set of credentials to maintain.
      AWS_REGION: env.AWS_REGION,
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
      S3_ENDPOINT_URL: env.S3_ENDPOINT_URL,
      S3_FORCE_PATH_STYLE: String(env.S3_FORCE_PATH_STYLE),
      S3_BUCKET: env.S3_BUCKET,
      BASE_DOMAIN: env.BASE_DOMAIN,
      ...Object.fromEntries(job.userEnvVars.map((v) => [v.name, v.value])),
      // Same vars again, JSON-encoded. The flat spread above can't be picked
      // apart from REDIS_URL/AWS_*/etc., which is fine for runStaticBuild()
      // (everything just lands in process.env) but not for runDynamicBuild():
      // docker-build.js's nested `docker build` runs in an isolated context
      // that inherits none of this env, so it needs an explicit list of
      // exactly which vars to forward as --build-arg. See script.js's
      // parsing and dockerfile-resolver.js.
      USER_ENV_VARS_JSON: JSON.stringify(job.userEnvVars),
    };

    const containerId = await dockerRun({
      image: env.DOCKER_BUILD_ENGINE_IMAGE,
      name: containerName,
      envVars,
      // Only a DYNAMIC build uses this (`docker build` against the host
      // daemon — see build-engine/docker-build.js); mounted unconditionally,
      // simpler than branching per DEPLOYMENT_TYPE.
      volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
    });

    // Opaque handle — stopBuildTask() hands it straight to `docker rm -f`.
    return { buildContainerId: containerId };
  }

  async stopBuildTask(buildContainerId: string): Promise<void> {
    await dockerRemove(buildContainerId);
  }

  async deployDynamicApp(job: DynamicDeployJob): Promise<EngineDynamicHandle> {
    const containerName = this.appContainerNameFor(job.projectSlug);
    // Started under a throwaway name, promoted to containerName only once
    // confirmed healthy (try/catch below) — the OLD container keeps serving
    // traffic the whole time the new one boots, so a redeploy is a staged
    // swap, never stop-then-start downtime.
    const stagingName = `${containerName}-staging-${Date.now()}`;

    const envVars: Record<string, string> = {
      PORT: '3000',
      HOSTNAME: '0.0.0.0',
      NODE_ENV: 'production',
      ...Object.fromEntries(job.userEnvVars.map((v) => [v.name, v.value])),
    };

    const containerId = await dockerRun({
      image: job.imageUri,
      name: stagingName,
      envVars,
      memory: '512m',
      cpus: '0.5',
    });

    try {
      await waitForHttpReady(`http://${stagingName}:3000`);
    } catch (err) {
      // New container never came up — abort the swap, leave whatever was
      // previously running untouched rather than take a working deployment
      // down for a build that's broken at runtime (boot crash, bad PORT, etc).
      await dockerRemove(stagingName);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `New container for project "${job.projectSlug}" did not become healthy — deploy aborted, ` +
          `previous deployment (if any) left running. ${reason}`
      );
    }

    // Confirmed up — NOW safe to remove whatever was running under the
    // canonical name. The gap until the rename below is a couple of `docker`
    // CLI calls, not a container boot — the actual redeploy downtime.
    const existingId = await dockerInspectId(containerName);
    if (existingId) {
      await dockerRemove(containerName);
    }
    await dockerRename(stagingName, containerName);

    return {
      appContainerId: containerId,
      appContainerName: containerName,
      // Container-to-container DNS — deliberately NO host port published,
      // matching docker-compose.yml's "only nginx publishes a host port"
      // posture; reverse-proxy sits on the same network and proxies here.
      appUrl: `http://${containerName}:3000`,
    };
  }

  async stopDynamicApp(appContainerName: string): Promise<void> {
    await dockerRemove(appContainerName);
  }
}

export const deploymentEngine: DeploymentEngine = new DockerDeploymentEngine();
