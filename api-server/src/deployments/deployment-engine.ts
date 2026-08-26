import { env } from '../lib/env';
import { dockerRun, dockerRemove, dockerInspectId, dockerRename, waitForHttpReady } from '../lib/docker-engine';

/**
 * Everything deployment.service.ts needs from "whatever actually runs the
 * build" — Dependency Inversion: the high-level module depends on this
 * abstraction; DockerDeploymentEngine depends on it too, by implementing it.
 * (This codebase has exactly one implementation now — the abstraction is
 * kept because deployment.service.ts is written against it, not because
 * a second implementation is expected.)
 */
export interface DeploymentEngine {
  /**
   * `gitAccessToken` is a separate argument, not part of `job`, on purpose —
   * `job` (BuildJob) is exactly what's stored as BullMQ job data in Redis;
   * the decrypted token must never be part of that persisted payload. See
   * build.worker.ts for where it's resolved, and deployment.service.ts's
   * createDeploymentInternal for why it's kept out of job.data.
   */
  launchBuildTask(job: BuildJob, gitAccessToken?: string): Promise<EngineHandle>;

  /**
   * Stops an in-flight build task/container. Idempotent — calling it on a
   * container that already exited does not throw, it just no-ops — which
   * is exactly the semantics stopDeployment() in deployment.service.ts
   * wants: it's allowed to call this speculatively without first
   * re-checking Docker's live state.
   */
  stopBuildTask(buildContainerId: string): Promise<void>;

  /**
   * Takes a DYNAMIC deployment's freshly-built local image (see
   * build-engine's docker-build.js) and turns it into a live, publicly
   * reachable container. Called from deployment.service.ts's
   * handleImageReady() — the handler for the `image_ready` event
   * build-engine publishes once its `docker build` step finishes (see
   * realtime.types.ts).
   *
   * Idempotent by design at the "one container per PROJECT" level: if
   * job.projectSlug already has a running container (a redeploy), this
   * replaces it — with a health-checked staged swap, not a hard stop-
   * then-start; see the implementation. This mirrors how STATIC
   * deployments already share one output prefix per project rather than
   * accumulating one per deployment.
   */
  deployDynamicApp(job: DynamicDeployJob): Promise<EngineDynamicHandle>;

  /**
   * Tears down a DYNAMIC deployment's running container. Like
   * stopBuildTask, this is written to be safely callable even if the
   * container is already gone (a redeploy may have already replaced it
   * under a race, or a user double-clicks Stop) — dockerRemove() swallows
   * "no such container" rather than surfacing it as a failure to the
   * caller.
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
  // local-engine — see docs/architecture/local-engine-auth-and-networking.md
  // Decision 2. No installationId anymore: there's one operator-wide PAT,
  // not a per-project link. `isPrivate` is all this job needs to know —
  // build.worker.ts decrypts the PAT itself (lib/git-credentials.ts) right
  // before the launchBuildTask call that needs it, same "never persisted
  // into BullMQ job data" property the old installationId comment
  // described, just with one less indirection.
  isPrivate: boolean;
  // Resolved build config from the Project row (see project.service.ts
  // and build-config/). null on any field means "build-engine should fall
  // back to its own default" — see script.js's INSTALL_COMMAND/BUILD_COMMAND/
  // OUTPUT_DIRECTORY fallbacks, which exist specifically so a project created
  // before this feature shipped (every column null) keeps building exactly
  // as it did before, with zero migration needed on the Project table itself.
  rootDirectory: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  /**
   * Decrypted project env vars scoped to this deployment's environment
   * (PRODUCTION or PREVIEW), resolved by deployment.service.ts right before
   * calling launchBuildTask. Forwarded into the build container's own
   * environment, available to the build/runtime exactly like a `.env` file
   * would be on a normal local build.
   */
  userEnvVars: Array<{ name: string; value: string }>;
  /**
   * Forwarded to build-engine as the DEPLOYMENT_TYPE container env var.
   * This is the ONLY thing that decides whether script.js takes the
   * static-upload branch or the local-docker-build branch after the build
   * finishes — see script.js's `if (DEPLOYMENT_TYPE === 'DYNAMIC')`. Comes
   * straight off Project.detectedDeploymentType, same as the `type` field
   * createDeploymentInternal already copies onto the Deployment row itself.
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
  /** Project slug, NOT deployment slug — see appContainerName's comment on why the container is keyed per-project. */
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
 * The one and only DeploymentEngine implementation. Shells out to the
 * `docker` CLI via lib/docker-engine.ts — same pattern as dploy's
 * internal/pipeline/docker_exec.go — for both build containers and
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
    // REDIS_URL (not REDIS_BUILDER_URL) forwarded here on purpose —
    // build-engine's own pub/sub logging is a general-Redis concern, not
    // a BullMQ one.
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
      // MinIO — forwarded from this process's own resolved env, so
      // build-engine's S3 client talks to the same bucket without a
      // second, separately-maintained set of credentials.
      AWS_REGION: env.AWS_REGION,
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
      S3_ENDPOINT_URL: env.S3_ENDPOINT_URL,
      S3_FORCE_PATH_STYLE: String(env.S3_FORCE_PATH_STYLE),
      S3_BUCKET: env.S3_BUCKET,
      BASE_DOMAIN: env.BASE_DOMAIN,
      ...Object.fromEntries(job.userEnvVars.map((v) => [v.name, v.value])),
    };

    const containerId = await dockerRun({
      image: env.DOCKER_BUILD_ENGINE_IMAGE,
      name: containerName,
      envVars,
      // Only a DYNAMIC build's runDynamicBuild() actually uses this (to
      // run `docker build` against the host daemon — see
      // build-engine/docker-build.js) — mounting it unconditionally for
      // STATIC builds too is simpler than branching per DEPLOYMENT_TYPE
      // here, and costs a STATIC build nothing it doesn't already ignore.
      volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
    });

    // Opaque handle — stopBuildTask() below hands it straight to
    // `docker rm -f`. Nothing downstream parses it as anything else.
    return { buildContainerId: containerId };
  }

  async stopBuildTask(buildContainerId: string): Promise<void> {
    await dockerRemove(buildContainerId);
  }

  async deployDynamicApp(job: DynamicDeployJob): Promise<EngineDynamicHandle> {
    const containerName = this.appContainerNameFor(job.projectSlug);
    // Started under a throwaway name first, promoted to containerName
    // only once confirmed healthy — see the try/catch below. This is
    // what keeps a redeploy from being a hard stop-then-start: the OLD
    // container keeps serving traffic (reverse-proxy's route still
    // resolves to it, since appUrl on the Deployment row hasn't changed
    // name yet) for the entire time the NEW one is building up / booting.
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
      // New container never came up — abort the swap and leave whatever
      // was previously running (if anything) untouched, rather than
      // taking a working deployment down for a build that turned out to
      // be broken at runtime (crashes on boot, wrong PORT binding, etc).
      await dockerRemove(stagingName);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `New container for project "${job.projectSlug}" did not become healthy — deploy aborted, ` +
          `previous deployment (if any) left running. ${reason}`
      );
    }

    // New container is confirmed up — NOW it's safe to remove whatever
    // was previously running under the canonical name. The window
    // between this remove and the rename just below is a couple of
    // `docker` CLI calls, not a full container boot — the actual gap a
    // redeploy causes.
    const existingId = await dockerInspectId(containerName);
    if (existingId) {
      await dockerRemove(containerName);
    }
    await dockerRename(stagingName, containerName);

    return {
      appContainerId: containerId,
      appContainerName: containerName,
      // Container-to-container DNS on DOCKER_NETWORK — deliberately NO
      // host port published, matching docker-compose.yml's "only nginx
      // publishes a host port" posture. reverse-proxy sits on the same
      // network and proxies here directly — see
      // apps/reverse-proxy/index.js's DYNAMIC branch.
      appUrl: `http://${containerName}:3000`,
    };
  }

  async stopDynamicApp(appContainerName: string): Promise<void> {
    await dockerRemove(appContainerName);
  }
}

export const deploymentEngine: DeploymentEngine = new DockerDeploymentEngine();
