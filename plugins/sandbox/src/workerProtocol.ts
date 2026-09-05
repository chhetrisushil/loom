import type { EvalLimits, TrippedGuard } from "./evalCore";

// ── ADR 0089 — the wire between the effect and a sandbox worker ──────────────
//
// Both directions carry the payload as JSON BYTES in a transferable Uint8Array,
// never as a live object. Measured on a 3.68 MiB reshape output, round trip:
// structured clone 66.5 ms, JSON + transfer 24.1 ms. Structured clone walks the
// object graph on both threads; a transfer moves the buffer without copying it,
// and the JSON step is work the sandbox does anyway (the VM is seeded from a
// JSON string, and the output is measured in JSON bytes for `maxOutputBytes`).

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
