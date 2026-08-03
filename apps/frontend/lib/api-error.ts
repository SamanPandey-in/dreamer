// Carries the API's machine-readable error code and requestId (see
// error-handler.middleware.ts's { error, code, requestId } response shape)
// on the thrown Error, rather than only the human-readable message. Every
// existing catch site that does `err instanceof Error ? err.message : ...`
// keeps working unchanged (ApiError IS an Error); code lets new call sites
// branch on the specific failure (the wizard's GITHUB_NOT_CONNECTED
// handling, e.g.), and requestId is what makes a bug report traceable back
// to the exact server-side log line.
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly requestId: string | undefined
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The one place every page's `catch (err) { setError(...) }` should go
 * through, instead of repeating `err instanceof Error ? err.message :
 * fallback` with no way to show a support reference. When the error came
 * from the API, appends "(ref: <requestId>)" — the same ID that's in the
 * server's own logs for that request, so a bug report naming it is
 * instantly greppable server-side.
 */
export function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.requestId ? `${err.message} (ref: ${err.requestId})` : err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Shared by dashboard-api.ts's parseJson and auth.ts's parseAuthResponse. */
export function extractRequestId(data: unknown, res: Response): string | undefined {
  const bodyRequestId = data && typeof data === "object" && "requestId" in data ? (data as { requestId?: string }).requestId : undefined;
  return bodyRequestId ?? res.headers.get("x-request-id") ?? undefined;
}
