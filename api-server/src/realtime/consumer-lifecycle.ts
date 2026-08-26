import { logger } from '../lib/logger';

/**
 * NEW. Owns whether log-relay.ts's expensive Redis Stream polling
 * (XREADGROUP + XAUTOCLAIM) should be running AT ALL right now — separate
 * from log-relay.ts's own connection/consumer-group mechanics, and
 * deliberately a standalone leaf module (imports nothing from log-relay.ts
 * or deployment.service.ts) so both of THEM can depend on this without a
 * circular import: deployment.service.ts calls ensureConsumerRunning() the
 * instant a deployment is queued; log-relay.ts registers what "running"
 * actually means (its own start/stop functions) once at boot. Neither
 * needs to import the other for this.
 *
 * WHY THIS EXISTS: log-relay.ts's XREADGROUP/XAUTOCLAIM loop previously
 * ran 24/7 regardless of whether any deployment was in progress — real,
 * measured cost even after slowing its poll cadence down (see that file's
 * own STREAM_READ_BLOCK_MS/RECLAIM_INTERVAL_MS comments — ~130K-170K
 * commands/month baseline even fully idle). For most projects, almost all
 * of that is spent asking "is there a new deployment event?" when the
 * honest answer is "nothing is even deploying right now." Gating the loop
 * on actual deployment activity turns a fixed 24/7 Redis cost into a cost
 * proportional to (fraction of time something is actually deploying) —
 * for most projects, a small fraction of the day.
 *
 * Correctness note (READ THIS before changing the trigger points): the
 * two callers of this module — see deployment.service.ts — start polling
 * the INSTANT a deployment is created (QUEUED), and separately, a
 * low-frequency Postgres-backed reconciliation (reconcileLogRelayActivity)
 * acts as the source of truth every couple of minutes, correcting for: a
 * process restart while something else's deployment is mid-flight, and
 * eventually stopping polling after the last active deployment finishes.
 * The reconciliation check deliberately uses Postgres (the deployment's
 * `status` column — already the single source of truth for this), NOT a
 * separate Redis counter — a Redis-based counter would need its own
 * correctness story (incrementing/decrementing reliably across a crash,
 * and across however many api-server replicas might be running) for the
 * exact resource we're trying to spend LESS of. Postgres reads cost
 * nothing against the Redis quota this whole change exists to protect.
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
 * Called from deployment.service.ts's createDeploymentInternal, the moment
 * a deployment row is created with status QUEUED — starts THIS process's
 * own consumer loop immediately, in the same request that created the
 * deployment, rather than waiting for the next periodic reconciliation
 * tick. This is the PRIMARY trigger; reconcileLogRelayActivity below is
 * the safety net, not the other way around.
 *
 * Safe to call when already running or before log-relay has finished its
 * own boot sequence (controller is still null) — log-relay's start() is
 * itself idempotent, and registerConsumerLifecycle always runs before this
 * codebase's first possible deployment creation (both happen at api-server
 * boot / first HTTP request respectively).
 */
export function ensureConsumerRunning(): void {
  if (!controller) {
    logger.warn('ensureConsumerRunning called before log-relay finished booting — will rely on the next reconciliation tick instead');
    return;
  }
  controller.start();
}

/**
 * Called ONLY from the periodic Postgres-backed reconciliation
 * (reconcileLogRelayActivity in deployment.service.ts) once it confirms
 * NOTHING is currently non-terminal system-wide. Deliberately no direct
 * "stop the instant this deployment finishes" call from inside log-relay's
 * own event-processing path — the marginal saving (stopping a few minutes
 * earlier) isn't worth the extra coupling, and relying solely on the
 * periodic check means this can never stop prematurely while something
 * else is still genuinely in flight.
 */
export function ensureConsumerStopped(): void {
  controller?.stop();
}
