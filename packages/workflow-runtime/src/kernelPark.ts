import type { SuspendError } from "@loom/core";

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
