import type { EventEnvelope } from "@loom/core";

/**
 * K9.4 — a fenced store rejected an append carrying a stale (or missing)
 * fencing token: the execution was re-dispatched under a newer token, so the
 * writer is a "zombie" — a network-partitioned or presumed-dead worker whose
 * writes must not land after its execution moved elsewhere. Extends the D3
 * single-writer invariant to the failure domain.
 */
export class StaleFenceError extends Error {
  constructor(
    readonly executionId: string,
    readonly staleFence: number | undefined,
    readonly currentFence: number,
    /** The error this was re-raised from, when a decorator rewrote it (e.g. tenant unscoping). */
    readonly cause?: unknown
  ) {
    super(
      `stale fence for execution "${executionId}": append carried ` +
        `${staleFence === undefined ? "no token" : `token ${staleFence}`}, current fence is ${currentFence}`
    );
    this.name = "StaleFenceError";
    Object.setPrototypeOf(this, StaleFenceError.prototype);
  }
}

/** The fencing token an envelope carries (in `metadata.fence`), if any. */
export function fenceOf(envelope: EventEnvelope): number | undefined {
  const fence = envelope.metadata?.fence;
  return typeof fence === "number" ? fence : undefined;
}
