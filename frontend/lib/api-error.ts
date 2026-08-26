/**
 * Carries the API's machine-readable `code` and `requestId` on the thrown
 * Error: `code` lets call sites branch on specific failures, requestId makes
 * bug reports traceable to server logs, and extending Error keeps existing
 * `err instanceof Error ? err.message` catch sites working unchanged.
 */
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
 * Single funnel for page-level `catch (err) { setError(...) }` handling:
 * returns just the clean, human-readable message. Pair with
 * getErrorRequestId() to surface the support reference separately instead
 * of inline with the sentence a user actually reads.
 */
export function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Pairs with describeApiError() — render as a separate small "Reference:" line, never inline with the message itself. */
export function getErrorRequestId(err: unknown): string | undefined {
  return err instanceof ApiError ? err.requestId : undefined;
}

/** Prefers a requestId from the response body, falling back to the x-request-id header. */
export function extractRequestId(data: unknown, res: Response): string | undefined {
  const bodyRequestId = data && typeof data === "object" && "requestId" in data ? (data as { requestId?: string }).requestId : undefined;
  return bodyRequestId ?? res.headers.get("x-request-id") ?? undefined;
}
