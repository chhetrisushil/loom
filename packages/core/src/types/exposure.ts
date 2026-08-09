/**
 * A request that is the CALLER's fault, whose message is therefore safe to return to them.
 *
 * The distinction matters because "body exceeds 10485760 bytes" and "Unexpected token in
 * JSON" are useful, self-inflicted, and reveal nothing — while a storage or provider error
 * is neither the caller's business nor safe to hand them. Throwing a type rather than
 * pattern-matching message text is what keeps that line from eroding.
 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}

/** What to send a caller, and what to keep. */
export interface ExposedError {
  status: number;
  /** The response body. Contains no internal detail. */
  body: { error: string; errorId?: string };
  /**
   * The original error when it was INTERNAL — hand it to a server-side log alongside
   * `body.errorId`, never to the caller. `undefined` for client errors, whose message is
   * already in `body`.
   */
  internal?: unknown;
}

/**
 * Decide what an HTTP surface may say about a failure.
 *
 * Every server in this repo answered a 500 with the raw `err.message`. That reaches an
 * *unauthenticated* caller on the A2A and worker endpoints, and error text is exactly where
 * internals surface: a Postgres error names tables and constraints, a filesystem error
 * names paths, a provider error can carry a request id or partial credentials.
 *
 * So: a client error keeps its message (it describes the caller's own request), and an
 * internal error becomes a fixed string plus a correlation id. The id is the point — it
 * makes the response diagnosable without making it informative, because an operator can
 * grep the id in their logs and find the real error that this function handed them instead.
 *
 * `newId` is injected because `@loom/core` deliberately imports no node builtins; callers
 * pass `randomUUID`.
 */
export function exposeError(err: unknown, newId: () => string): ExposedError {
  if (err instanceof BadRequestError) {
    return { status: 400, body: { error: err.message } };
  }
  const errorId = newId();
  return {
    status: 500,
    body: { error: "internal error", errorId },
    internal: err,
  };
}
