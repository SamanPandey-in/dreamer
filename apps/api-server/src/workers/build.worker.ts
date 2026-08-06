import { Worker, type Job } from 'bullmq';
import { BUILD_QUEUE_NAME, createQueueConnection } from '../lib/queue';
import { deploymentEngine, type BuildJob } from '../deployments/deployment-engine';
import { prisma } from '../lib/prisma';
import { transitionDeploymentStatus } from '../deployments/deployment.service';
import { logger, runWithContext } from '../lib/logger';

const CONCURRENCY = Number(process.env.BUILD_WORKER_CONCURRENCY ?? 5);

/**
 * The only place deploymentEngine.launchBuildTask is called from. Everything
 * up to this point (Deployment row creation, ownership checks, env var
 * resolution) already happened synchronously in deployment.service.ts's
 * createDeploymentInternal — this worker's only job is the slow, ECS-facing
 * part, decoupled so a burst of deploy requests doesn't translate 1:1 into a
 * burst of concurrent RunTaskCommand calls.
 *
 * Jobs aren't HTTP requests, so there's no requestId to inherit — the
 * deploymentId IS the correlation ID here (it's already unique, already the
 * thing every UI surface keys logs/status off of, and already what
 * realtime/log-relay.ts tags every log line from the ECS task itself with).
 * That gives one correlation story end-to-end: API request that created the
 * deployment -> this worker's launch attempt(s) -> the running build-engine
 * task's own logs -> back through the socket relay to the browser.
 */
const worker = new Worker<BuildJob>(
  BUILD_QUEUE_NAME,
  (job: Job<BuildJob>) =>
    runWithContext({ correlationId: job.data.deploymentId, source: 'build-worker' }, async () => {
      // Guards the rare race with stopDeployment's QUEUED->CANCELLED path:
      // buildQueue.remove() only removes jobs still waiting, so a job that
      // became 'active' in the same instant a user hit Stop can still reach
      // here. Re-check the row rather than trusting the job data is still
      // current — launching ECS for an already-cancelled deployment would
      // just leak a task nothing will ever stop cleanly.
      const current = await prisma.deployment.findUnique({
        where: { id: job.data.deploymentId },
        select: { status: true },
      });
      if (current?.status !== 'QUEUED') {
        logger.warn('Skipping build job: deployment is no longer QUEUED', {
          status: current?.status ?? 'missing',
        });
        return;
      }

      logger.info('Launching build task', { attempt: job.attemptsMade + 1 });
      const handle = await deploymentEngine.launchBuildTask(job.data);
      await prisma.deployment.update({
        where: { id: job.data.deploymentId },
        data: { ecsTaskArn: handle.ecsTaskArn },
      });
      logger.info('Build task launched', { ecsTaskArn: handle.ecsTaskArn });
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

    logger.error('Build launch failed permanently, marking deployment FAILED', { attempts, err });

    try {
      await transitionDeploymentStatus(job.data.deploymentId, 'FAILED', {
        reason: 'Failed to launch build task',
        errorCode: 'ENGINE_LAUNCH_FAILED',
        errorMessage: err instanceof Error ? err.message : 'Unknown engine error',
        triggeredBy: 'api',
      });
    } catch (transitionErr) {
      // If even this fails, the deployment is stuck at QUEUED with no worker
      // ever retrying it again — surface loudly, this needs a human or an
      // alert, not a silent swallow.
      logger.error('Also failed to record FAILED status after exhausting retries', { err: transitionErr });
    }
  });
});

worker.on('error', (err) => {
  // Connection-level errors (e.g. Redis blip) — BullMQ retries the
  // connection itself, this is just visibility. No per-job correlation ID
  // available at this point, so it logs without one.
  logger.error('Worker-level error', { source: 'build-worker', err });
});

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, closing gracefully`, { source: 'build-worker' });
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info(`Listening on "${BUILD_QUEUE_NAME}"`, { source: 'build-worker', concurrency: CONCURRENCY });
