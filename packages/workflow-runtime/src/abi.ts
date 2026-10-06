// ── The kernel ABI (Loom 2.0 K1) ─────────────────────────────────────────────
//
// `ExecutionContext` is the stable, versioned "syscall" surface — the narrow,
// guaranteed boundary between userspace (flows, agents) and the durable kernel.
// This module NAMES and VERSIONS that boundary so apps can depend on it and CI can
// catch drift. Compatibility guarantee:
//   • Adding a syscall bumps the MINOR version.
//   • Removing or renaming a syscall, or changing its meaning, is a MAJOR break and
//     must be deliberate — the conformance test pins this table so it cannot happen
//     silently.
// Everything below the syscall boundary (event schema, stores, scheduler) is the
// kernel's own concern; everything above builds only against these calls.

// 1.1.0: added `sleep` / `sleepUntil` (T1 — durable timers). Additive = MINOR.
// 1.2.0: `decide`'s decider now receives a `DecideScope` argument (L30). Additive = MINOR:
//        a `() => T` decider is unchanged, but a flow that USES the scope throws on an
//        older kernel, so it must be able to require >= 1.2.0.
// 1.3.0: Wave 2 (W2-0) RESERVES the bump with the rest of the coordinated version plan. It adds
//        `continueAsNew`, `receive` and `select` (ADRs 0109/0110) and deprecates `ui` (ADR 0114)
//        in their item PRs; no syscall enters `KERNEL_SYSCALLS` here, because a syscall without a
//        writer behind its `kernel.features` flag would be a lie in the table.
export const KERNEL_ABI_VERSION = "1.3.0";

export type SyscallKind = "call" | "accessor";

export interface KernelSyscall {
  /** The property name on `ExecutionContext`. */
  readonly name: string;
  /** `call` = a method; `accessor` = a property object (e.g. `ui`). */
  readonly kind: SyscallKind;
  /** ABI version the syscall was introduced in. */
  readonly since: string;
  readonly summary: string;
}

// The syscall table. Order is not significant; names are the contract.
export const KERNEL_SYSCALLS: readonly KernelSyscall[] = [
  {
    name: "execute",
    kind: "call",
    since: "1.0.0",
    summary: "run any task to durable completion (the generalized primitive)",
  },
  {
    name: "run",
    kind: "call",
    since: "1.0.0",
    summary: "run a step — the 'step' task alias of execute",
  },
  {
    name: "decide",
    kind: "call",
    since: "1.0.0",
    // 1.2.0 (L30): the decider receives a DecideScope (a transient invoker stamped as
    // this execution). The syscall's name/kind/replay meaning are unchanged, so `since`
    // stays 1.0.0; the argument is what 1.2.0 added.
    summary: "record an advisory/optimizer choice durably; served on replay (P9)",
  },
  {
    name: "parallel",
    kind: "call",
    since: "1.0.0",
    summary: "run tasks concurrently, input-order-preserving",
  },
  {
    name: "suspend",
    kind: "call",
    since: "1.0.0",
    summary: "pause durably until an external signal, then resume from here",
  },
  {
    name: "sleep",
    kind: "call",
    since: "1.1.0",
    summary: "suspend durably for a duration; the wake is a logged TIMER_FIRED fact (T1)",
  },
  {
    name: "sleepUntil",
    kind: "call",
    since: "1.1.0",
    summary: "suspend durably until an absolute time recorded in the log (T1)",
  },
  { name: "emit", kind: "call", since: "1.0.0", summary: "append a durable domain event" },
  { name: "stream", kind: "call", since: "1.0.0", summary: "emit an incremental delta event" },
  {
    name: "ui",
    kind: "accessor",
    since: "1.0.0",
    summary: "drive durable, replayable UI surfaces (agent-surface)",
  },
] as const;

export interface KernelAbi {
  readonly version: string;
  readonly syscalls: readonly KernelSyscall[];
}

export const KERNEL_ABI: KernelAbi = {
  version: KERNEL_ABI_VERSION,
  syscalls: KERNEL_SYSCALLS,
};
