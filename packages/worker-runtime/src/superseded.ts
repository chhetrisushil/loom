/**
 * L20 (ADR 0004) — `execute` was refused because ANOTHER holder owns the execution. This is the
 * portable form of that refusal: the HTTP worker answers it with
 * `409 { code: "superseded", executionId }` and `RemoteWorkerRuntime` rethrows it as this error,
 * so a caller on the far side of a wire can tell it apart from a transport or storage failure
 * exactly as an in-process caller can.
 *
 * It is NOT a failed attempt. Every dispatch acquires a newer fence, so retrying it supersedes
 * the holder that just won, which is then fenced out and retries in turn — the two ping-pong and
 * each bounce re-runs the in-flight step. So a dispatcher settles it instead of retrying.
 *
 * What settling means: the refusal TRANSFERS ownership to the newer fence holder, and nothing
 * here checks that holder is alive. Its liveness is covered only by its own dispatcher's policy
 * (retries, `executeTimeoutMs`) and, past that, by `recoverAbandoned` — which a deployment MUST
 * run to cover holders that die (a duplicate dispatcher that crashed mid-run, or one that timed
 * out while its wedged instance kept the fence). Until then the execution may sit in `running`.
 *
 * The newer holder can even be this caller's own earlier attempt (an HTTP attempt that timed out
 * but kept running): the execution then completes while `dispatch()` rejects with this error.
 * So a caller that needs the OUTCOME should treat this error as "await by id" —
 * `loadState` / `subscribe` on the same executionId — not as a failure of the execution.
 */
export class ExecutionSupersededError extends Error {
  constructor(
    readonly executionId: string,
    /** What the worker was refused with, when known (in-process). Absent across a wire. */
    readonly cause?: unknown
  ) {
    super(
      `execution "${executionId}" is owned by another holder (a lost start race or a newer fence); this dispatch was superseded, not failed — redispatching would fence that holder out. Await the execution by id (loadState/subscribe); if its holder has died, recoverAbandoned re-drives it.`
    );
    this.name = "ExecutionSupersededError";
    Object.setPrototypeOf(this, ExecutionSupersededError.prototype);
  }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * L20 (ADR 0004) — does `err` mean "a newer or other holder owns `executionId`", rather than
 * "this attempt failed"? A dispatcher MUST NOT retry or redispatch on `true`.
 *
 * Exactly three shapes, each REQUIRED to name `executionId` so an error about some other
 * execution never qualifies:
 *  - `ExecutionAlreadyExistsError` — a start lost the sequence-0 race (ADR 0103);
 *  - `StaleFenceError`, bare or as the `cause` of a `StorageWriteError` — this attempt's token
 *    was superseded by a newer `acquireFence` (a redispatch, a recovery pass, a fenced wake or a
 *    cancel). The id check matters: a coalesced batch rejects every caller in it with ONE
 *    writer's error (ADR 0074 L1), so a stale fence naming a different execution is that
 *    writer's refusal and, for this one, a genuine storage failure — retryable;
 *  - `ExecutionSupersededError` — the wire form of either.
 *
 * Not included: `StartFencedOutError` (`@loom/workflow-runtime`) — a start refused on the fence
 * with sequence 0 still absent. Its newer token's holder has written nothing and may be dead, so
 * settling would lose the start outright; it stays retryable.
 *
 * Accepted imprecision: a coalesced batch holding writes for TWO fenced-out executions rejects
 * both with the first one's error, so the second sees a stale fence naming another execution and
 * retries. That retry takes a newer fence, so it can supersede the second execution's live holder
 * and re-run its in-flight step once more; the holder it fences out then gets a refusal naming
 * its own execution and settles. One bounded extra bounce per such batch — not a ping-pong —
 * accepted rather than guessing which execution a batch error "really" meant.
 *
 * Every other error, including any other `StorageWriteError`, is `false`: a genuine failure is
 * never swallowed. Matched by `name`, not class, because `@loom/worker-runtime` sits below the
 * packages that define the first two (layering), and so a second bundled copy of any of them
 * cannot hide a refusal — the same rule as `isStaleFence` in `@loom/workflow-runtime`.
 */
export function isSupersededRefusal(err: unknown, executionId: string): boolean {
  const name = field(err, "name");
  if (
    name === "ExecutionAlreadyExistsError" ||
    name === "ExecutionSupersededError" ||
    name === "StaleFenceError"
  ) {
    return field(err, "executionId") === executionId;
  }
  if (name === "StorageWriteError") {
    const cause = field(err, "cause");
    return (
      field(cause, "name") === "StaleFenceError" && field(cause, "executionId") === executionId
    );
  }
  return false;
}
