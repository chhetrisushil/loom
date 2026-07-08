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

export const KERNEL_ABI_VERSION = "1.0.0";

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
  { name: "emit", kind: "call", since: "1.0.0", summary: "append a durable domain event" },
  { name: "stream", kind: "call", since: "1.0.0", summary: "emit an incremental delta event" },
  {
    name: "ui",
    kind: "accessor",
    since: "1.0.0",
    summary: "drive durable, replayable UI surfaces (A2UI)",
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
