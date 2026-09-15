import type { EvalLimits, TrippedGuard } from "./evalCore";

// ── ADR 0089 — the wire between the effect and a sandbox worker ──────────────
//
// Both directions carry the payload as JSON BYTES in a transferable Uint8Array,
// never as a live object. Measured on a 3.68 MiB reshape output, round trip:
// structured clone 66.5 ms, JSON + transfer 24.1 ms. Structured clone walks the
// object graph on both threads; a transfer moves the buffer without copying it,
// and the JSON step is work the sandbox does anyway (the VM is seeded from a
// JSON string, and the output is measured in JSON bytes for `maxOutputBytes`).

// ── The run-status word (#399) ───────────────────────────────────────────────
//
// `wallClockMs` bounds the SCRIPT. The parent's kill timer is a `setTimeout` on the
// parent's event loop, so left alone it measures the script PLUS however long that loop
// took to post the eval and to drain the reply — and libuv runs the timers phase before
// the poll phase, so a due deadline can fire ahead of a reply that already arrived. On a
// contended host that turns a fast script into `limitExceeded { wallClock }`: a resource
// kill routed to drift-repair, for a script that was never the problem.
//
// So the worker publishes what only the worker knows — when the script actually started,
// and whether it is still running — into shared memory the parent reads SYNCHRONOUSLY when
// its timer fires. No message, no event loop, no race.

/** Byte layout of the status buffer: `[state: i32, runId: i32]` then `[startedAt: f64]`. */
export const STATUS_BYTES = 16;
export const STATUS_STATE_INDEX = 0;
export const STATUS_RUN_ID_INDEX = 1;
/** Byte offset of the `startedAt` float (after the two i32 fields). */
export const STATUS_STARTED_AT_OFFSET = 8;

export const RUN_IDLE = 0;
/** The worker is inside `evalInFreshRuntime` for `runId`. */
export const RUN_EVALUATING = 1;
/** The script returned; the reply is posted or about to be. */
export const RUN_FINISHED = 2;

/** Parent → worker. */
export type ToWorker =
  | { type: "warm" }
  | {
      type: "eval";
      runId: number;
      script: string;
      /** JSON of the step input. Transferred, not copied. */
      inputJson: Uint8Array;
      limits: EvalLimits;
      /**
       * Shared status word (see above). SHARED, not transferred — both threads hold the
       * same memory, which is the point: the parent reads it from inside a timer callback,
       * where it cannot receive a message.
       */
      status: SharedArrayBuffer;
    };

/** Worker → parent. */
export type FromWorker =
  | { type: "ready" }
  | {
      type: "result";
      runId: number;
      /**
       * JSON of the completion value, transferred. `null` distinguishes a script
       * that completed with `undefined` — which has no JSON encoding — from one
       * that returned the JSON literal `null`.
       */
      outputJson: Uint8Array | null;
    }
  | { type: "failure"; runId: number; message: string; tripped?: TrippedGuard }
  /** The worker itself broke (module load, marshalling) — not a script outcome. */
  | { type: "fatal"; runId: number; message: string };
