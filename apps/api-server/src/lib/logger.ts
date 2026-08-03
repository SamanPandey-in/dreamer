import { AsyncLocalStorage } from 'node:async_hooks';

interface LogContext {
  /** requestId for HTTP requests, deploymentId for build-worker jobs — see runWithContext callers. */
  correlationId: string;
  /** e.g. 'http' | 'build-worker' | 'log-relay' — which part of the system this log came from. */
  source: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Wraps a function so every log call made anywhere inside it (including in
 * awaited service functions several layers deep) automatically carries
 * `correlationId`, without passing req/job through every signature.
 * request-context.middleware.ts calls this once per HTTP request;
 * build.worker.ts calls it once per job.
 */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, message: string, meta?: Record<string, unknown>) {
  const ctx = storage.getStore();
  const line = {
    level,
    time: new Date().toISOString(),
    message,
    correlationId: ctx?.correlationId,
    source: ctx?.source,
    ...meta,
  };
  // One JSON line per log — trivially greppable by correlationId today,
  // and directly ingestible by any log aggregator (CloudWatch, Datadog,
  // etc.) later without changing a single call site.
  const line_str = JSON.stringify(line, (_key, value) => (value instanceof Error ? serializeError(value) : value));
  if (level === 'error') console.error(line_str);
  else if (level === 'warn') console.warn(line_str);
  else console.log(line_str);
}

function serializeError(err: Error) {
  return { name: err.name, message: err.message, stack: err.stack };
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};
