import { SuspendError } from "@loom/core";
import type { SuspendWait } from "@loom/core";

// A park the KERNEL built for a human step (ADR 0104) is the only one allowed to name a
// `stepId`; the commit site strips the field from every other `SuspendError`, including one a
// flow throws raw. The mark is an identity-keyed WeakSet entry, not a property on the error, so
// no flow can set it by shaping an object (it holds only instances this module marked), and it
// cannot be serialised into a condition.
const KERNEL_HUMAN_PARKS = new WeakSet<SuspendError>();

/** Mark `err` as a kernel-built human-step park. Internal to the runtime. */
export function markKernelHumanPark<E extends SuspendError>(err: E): E {
  KERNEL_HUMAN_PARKS.add(err);
  return err;
}

/** Whether `err` is a kernel-built human-step park (so its `stepId` is the kernel's). */
export function isKernelHumanPark(err: SuspendError): boolean {
  return KERNEL_HUMAN_PARKS.has(err);
}

/**
 * ADR 0110 D2 — the park a QUIESCENT flow decides: every live branch is blocked on a registered
 * wait (`ctx.select` / `ctx.receive`) and nothing is in flight. Raised by the context into the
 * runner's race; the runtime builds the multi-wait `EXECUTION_SUSPENDED` (stamped, `waits` added
 * after the commit-site strip) from `waits`. A `SuspendError` subclass so every existing handler
 * of a park (the barrier, the seal, the snapshot) sees an ordinary park.
 */
export class WaitsPark extends SuspendError {
  constructor(readonly waits: readonly SuspendWait[]) {
    super({ on: "__loom_waits__" });
  }
}
