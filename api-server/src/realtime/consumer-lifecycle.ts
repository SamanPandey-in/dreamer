import { logger } from '../lib/logger';

/**
 * Owns whether log-relay.ts's expensive Redis Stream polling (XREADGROUP +
 * XAUTOCLAIM) should be running AT ALL right now — gated on actual deployment
 * activity instead of polling 24/7 while nothing is deploying. Deliberately a
 * standalone leaf module (imports nothing from log-relay.ts or
 * deployment.service.ts) so both of THEM can depend on this without a
 * circular import: deployment.service.ts calls ensureConsumerRunning() the
 * instant a deployment is queued; log-relay.ts registers what "running"
 * actually means once at boot.
 *
 * Correctness note: the instant-start trigger is primary; the low-frequency
 * Postgres-backed reconciliation (reconcileLogRelayActivity) is the safety
 * net that corrects for restarts mid-deployment and eventually stops polling.
 * Reconciliation deliberately reads Postgres's `status` column — already the
 * source of truth — rather than keeping a separate Redis counter, which would
 * need its own crash-safety story across replicas for the exact resource this
 * gating exists to conserve.
 */

interface ConsumerController {
  start: () => void;
  stop: () => void;
}

let controller: ConsumerController | null = null;

/** Called once by log-relay.ts at boot, before anything else touches this module. */
export function registerConsumerLifecycle(handlers: ConsumerController): void {
  controller = handlers;
}

/**
 * Primary trigger — called from deployment.service.ts's
 * createDeploymentInternal the moment a deployment row is QUEUED, starting
 * polling in the same request instead of waiting for the next periodic
 * reconciliation tick. Safe to call when already running or before log-relay
 * finished booting (controller still null): start() is idempotent, and the
 * periodic reconciliation covers anything missed.
 */
export function ensureConsumerRunning(): void {
  if (!controller) {
    logger.warn('ensureConsumerRunning called before log-relay finished booting — will rely on the next reconciliation tick instead');
    return;
  }
  controller.start();
}

/**
 * Called only from the periodic Postgres-backed reconciliation
 * (reconcileLogRelayActivity) once it confirms NOTHING is non-terminal
 * system-wide. Deliberately no direct stop-on-finish call from log-relay's
 * event-processing path — relying solely on the periodic check means this
 * can never stop prematurely while something else is genuinely in flight.
 */
export function ensureConsumerStopped(): void {
  controller?.stop();
}
