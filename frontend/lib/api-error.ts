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
 * fallback`. Returns just the clean, human-readable message — no request
 * ID mixed in. Use getErrorRequestId() alongside it (see <Alert>'s
 * `requestId` prop) to surface a support reference separately, rather
 * than concatenated into the sentence a user actually reads.
 */
export function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Pairs with describeApiError() — the requestId to show as a separate, small "Reference: …" line (see <Alert>), never inline with the message itself. */
export function getErrorRequestId(err: unknown): string | undefined {
  return err instanceof ApiError ? err.requestId : undefined;
}

/** Shared by dashboard-api.ts's parseJson and auth.ts's parseAuthResponse. */
export function extractRequestId(data: unknown, res: Response): string | undefined {
  const bodyRequestId = data && typeof data === "object" && "requestId" in data ? (data as { requestId?: string }).requestId : undefined;
  return bodyRequestId ?? res.headers.get("x-request-id") ?? undefined;
}
