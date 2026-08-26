import { pathToFileURL } from 'node:url';
import { Worker, type Job } from 'bullmq';
import { BUILD_QUEUE_NAME, createQueueConnection } from '../lib/queue';
import { deploymentEngine, type BuildJob } from '../deployments/deployment-engine';
import { prisma } from '../lib/prisma';
import { publishDeploymentEvent } from '../realtime/publish';
import { logger, runWithContext } from '../lib/logger';
import { getSingleOperatorGitAccessToken } from '../lib/git-credentials';

const CONCURRENCY = Number(process.env.BUILD_WORKER_CONCURRENCY ?? 5);

/**
 * The only place deploymentEngine.launchBuildTask is called from. Everything
 * up to this point (Deployment row creation, ownership checks, env var
 * resolution) already happened synchronously in deployment.service.ts's
 * createDeploymentInternal — this worker's only job is the slow, Docker-facing
 * part, decoupled so a burst of deploy requests doesn't translate 1:1 into a
 * burst of concurrent RunTaskCommand calls.
 *
 * ATOMIC CLAIM (fixes a real race): this used to read the row's status,
 * THEN call Docker, THEN write the container id — with no way to know whether a
 * concurrent Stop had already cancelled it in the meantime, and no way to
 * stop a task that had, by that point, already been launched. Now the very
 * first thing this does is a conditional UPDATE — `WHERE id = ? AND status
 * = 'QUEUED'` — that only succeeds if nothing else has moved the row off
 * QUEUED yet. deployment.service.ts's stopDeployment does the mirror-image
 * conditional UPDATE straight to CANCELLED, on the exact same WHERE clause.
 * Postgres serializes concurrent UPDATEs to one row: whichever of the two
 * commits first wins, and the loser's WHERE re-evaluates against the
 * already-committed value and matches zero rows. That's what makes this
 * genuinely atomic without an explicit lock — the row itself is the lock —
 * and it's what closes the exact gap CodeRabbit flagged in review.
 */
export function startBuildWorker() {
  const worker = new Worker<BuildJob>(
    BUILD_QUEUE_NAME,
    (job: Job<BuildJob>) =>
      runWithContext({ correlationId: job.data.deploymentId, source: 'build-worker' }, async () => {
        const claim = await prisma.deployment.updateMany({
          where: { id: job.data.deploymentId, status: 'QUEUED' },
          data: { status: 'LAUNCHING' },
        });

        if (claim.count === 0) {
          // Lost the claim — stopDeployment's own conditional UPDATE already
          // won (or, far less likely, this job somehow got processed twice).
          // Either way, launching now would be launching something already
          // cancelled — bail out entirely rather than proceed.
          logger.warn('Skipping build job: lost the QUEUED claim (already cancelled elsewhere)');
          return;
        }

        // updateMany doesn't write DeploymentStateTransition rows the way
        // transitionDeploymentStatus() does — do it explicitly so the audit
        // trail still has this hop.
        await prisma.deploymentStateTransition.create({
          data: { deploymentId: job.data.deploymentId, fromStatus: 'QUEUED', toStatus: 'LAUNCHING', triggeredBy: 'build-worker' },
        });

        // SECURITY — resolved right before the docker run call that needs it,
        // instead of at enqueue time. job.data (this function's own
        // argument) is exactly what BullMQ already persisted into Redis as
        // the job payload — a live credential must never be added to it.
        // See deployment-engine.ts's launchBuildTask signature and
        // deployment.service.ts's createDeploymentInternal for the other
        // ends of this.
        //
        // local-engine — see docs/architecture/local-engine-auth-and-networking.md
        // Decision 2. No installation-token minting anymore: the operator's
        // single PAT is decrypted straight from the DB. No expiry to race
        // against, no "suspended between enqueue and dequeue" case — a PAT
        // doesn't get revoked out from under a running job the way a GitHub
        // App installation could.
        let gitAccessToken: string | undefined;
        if (job.data.isPrivate) {
          gitAccessToken = await getSingleOperatorGitAccessToken();
          if (!gitAccessToken) {
            logger.error('Private repo build but no git Personal Access Token is configured', {
              deploymentId: job.data.deploymentId,
            });
            throw new Error('Private repo build but no git Personal Access Token is configured — set one in Settings');
          }
        }

        logger.info('Launching build task', { attempt: job.attemptsMade + 1 });
        const handle = await deploymentEngine.launchBuildTask(job.data, gitAccessToken);

        const withContainerId = await prisma.deployment.update({
          where: { id: job.data.deploymentId },
          data: { buildContainerId: handle.buildContainerId },
        });

        if (withContainerId.cancelRequested) {
          // A Stop landed after this worker won the QUEUED->LAUNCHING claim
          // but before a container id existed to act on — stopDeployment
          // could only flag intent (see its cancelRequested branch). This
          // is that flag being honored, the moment there's actually a
          // container to stop.
          //
          // NOTE: there's a narrow residual window here — if cancelRequested
          // gets set by a concurrent request in the few-ms gap between this
          // update() executing and its result being read, this check won't
          // see it on THIS pass. That's a DB-round-trip-sized window, not the
          // seconds-long "docker run in flight" window the atomic claim
          // above closes — accepted as an acceptable residual rather than
          // adding a second lock for a gap this narrow.
          logger.info('Cancellation was requested while launching — stopping the container that just started', {
            buildContainerId: handle.buildContainerId,
          });
          try {
            await deploymentEngine.stopBuildTask(handle.buildContainerId);
          } catch (err) {
            logger.error('Failed to stop late-launched container after cancellation', { err });
          }
          // log-relay.ts is the sole writer of status changes driven by
          // events on this channel — publish instead of calling
          // transitionDeploymentStatus directly, so this gets the same
          // "persist + push to sockets" handling as every build-engine event.
          await publishDeploymentEvent(job.data.deploymentId, {
            type: 'status',
            status: 'STOPPED',
            reason: 'Cancelled by user while the build was launching',
            triggeredBy: 'user',
          });
          return;
        }

        logger.info('Build task launched', { buildContainerId: handle.buildContainerId });
      }),
    {
      connection: createQueueConnection(),
      concurrency: CONCURRENCY,
    }
  );

  worker.on('failed', (job, err) => {
    if (!job) return;

    runWithContext({ correlationId: job.data.deploymentId, source: 'build-worker' }, async () => {
      const attempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade >= attempts;

      if (!isFinalAttempt) {
        logger.warn('Build launch attempt failed, will retry', { attempt: job.attemptsMade, attempts, err });
        return;
      }

      logger.error('Build launch failed permanently, marking deployment terminal', { attempts, err });

      try {
        const row = await prisma.deployment.findUnique({
          where: { id: job.data.deploymentId },
          select: { status: true, cancelRequested: true },
        });

        if (row?.status !== 'LAUNCHING') {
          // Already finalized by something else (e.g. the cancel-while-launching
          // branch above already moved it to STOPPED) — don't stomp on that.
          return;
        }

        // Nothing ever actually launched in this path (launchBuildTask itself
        // is what's failing) — CANCELLED is the accurate terminal state if the
        // user asked to stop it, not STOPPED (which implies something ran).
        await publishDeploymentEvent(job.data.deploymentId, row.cancelRequested
          ? { type: 'status', status: 'CANCELLED', reason: 'Cancelled by user; the build never successfully launched', triggeredBy: 'user' }
          : {
              type: 'status',
              status: 'FAILED',
              reason: 'Failed to launch build task',
              errorCode: 'ENGINE_LAUNCH_FAILED',
              errorMessage: err instanceof Error ? err.message : 'Unknown engine error',
              triggeredBy: 'api',
            });
      } catch (finalizeErr) {
        // If even this fails, the deployment is stuck at LAUNCHING with no
        // worker ever retrying it again — surface loudly, this needs a human
        // or an alert, not a silent swallow.
        logger.error('Also failed to record terminal status after exhausting retries', { err: finalizeErr });
      }
    });
  });

  worker.on('error', (err) => {
    // Connection-level errors (e.g. Redis blip, or Redis unreachable at boot)
    // — BullMQ retries the connection itself, this is just visibility. No
    // per-job correlation ID available at this point, so it logs without one.
    logger.error('Worker-level error', { source: 'build-worker', err });
  });

  worker.on('ready', () => {
    // If this line never shows up in your logs, the worker process either
    // isn't running at all, or can't reach Redis — see the troubleshooting
    // note in the top-level README. A queued deployment that never moves
    // past QUEUED and never shows a container in `docker ps` almost
    // always means this event never fired.
    logger.info('Redis connection ready, worker is now consuming jobs', { source: 'build-worker' });
    console.log('Build worker ready, consuming jobs from queue:', BUILD_QUEUE_NAME);
  });

  logger.info(`Starting up, connecting to "${BUILD_QUEUE_NAME}"`, { source: 'build-worker', concurrency: CONCURRENCY });

  return worker;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const worker = startBuildWorker();

  async function shutdown(signal: string) {
    logger.info(`Received ${signal}, closing gracefully`, { source: 'build-worker' });
    await worker.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
