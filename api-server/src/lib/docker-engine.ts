import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { env } from './env';

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the `docker` CLI, reached via the host socket
 * mounted into api-server/build-worker (docker-compose.yml). Same
 * approach as dploy's internal/pipeline/docker_exec.go: shell out with a
 * real argv array (never a shell string — no injection surface from a
 * project slug, branch name, or env var value), no Docker SDK dependency.
 */

export interface DockerRunOptions {
  image: string;
  /** Container name — also how other containers on DOCKER_NETWORK reach this one by DNS. */
  name: string;
  envVars?: Record<string, string>;
  /** Extra bind mounts, each "host:container[:ro]". */
  volumes?: string[];
  /** Defaults to env.DOCKER_NETWORK. */
  network?: string;
  /** Resource limits — same defaults dploy's RunReplica uses for app containers. */
  memory?: string;
  cpus?: string;
}

/**
 * `docker run -d ...`. Returns the new container's ID. Used both for
 * build-engine (one-shot: it exits on its own when script.js's init()
 * finishes) and for long-running app containers (dynamic/SSR deploys) —
 * the only difference between the two call sites is which image/env/
 * volumes get passed in, not this function itself.
 */
export async function dockerRun(opts: DockerRunOptions): Promise<string> {
  const args = ['run', '-d', '--name', opts.name, '--network', opts.network ?? env.DOCKER_NETWORK];

  if (opts.memory) args.push('--memory', opts.memory);
  if (opts.cpus) args.push('--cpus', opts.cpus);

  for (const [key, value] of Object.entries(opts.envVars ?? {})) {
    args.push('-e', `${key}=${value}`);
  }

  for (const volume of opts.volumes ?? []) {
    args.push('-v', volume);
  }

  args.push(opts.image);

  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim();
}

/**
 * `docker rm -f <nameOrId>`. Idempotent — a container that's already
 * gone (redeploy race, double-click Stop, manual cleanup) is treated as
 * success, not an error — same idempotency discipline as dploy's own
 * StopAndRemoveContainer.
 */
export async function dockerRemove(nameOrId: string): Promise<void> {
  if (!nameOrId) return;

  try {
    await execFileAsync('docker', ['rm', '-f', nameOrId]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/No such container/i.test(message)) {
      throw err;
    }
  }
}

/** `docker inspect --format {{.Id}} <name>` — null if the container doesn't exist. */
export async function dockerInspectId(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{.Id}}', name]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** `docker rename <oldName> <newName>`. */
export async function dockerRename(oldName: string, newName: string): Promise<void> {
  await execFileAsync('docker', ['rename', oldName, newName]);
}

/**
 * Polls a URL with a plain HTTP GET until it responds at all (any status
 * code — this checks "is the process up and accepting connections", not
 * "does it return 200") or timeoutMs elapses. Used by
 * DockerDeploymentEngine.deployDynamicApp to confirm a newly-started
 * container is actually serving before tearing down whatever it's
 * replacing — see that method's own comment for why.
 */
export async function waitForHttpReady(
  url: string,
  timeoutMs = 30_000,
  intervalMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const req = http.get(url, (res) => {
        res.destroy();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2_000, () => {
        req.destroy();
        resolve(false);
      });
    });

    if (reachable) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Container at ${url} did not become reachable within ${timeoutMs}ms`);
}
