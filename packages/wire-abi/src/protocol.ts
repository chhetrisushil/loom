import { KERNEL_ABI_VERSION, KERNEL_SYSCALLS } from "@loom/workflow-runtime";
import type { KernelSyscall } from "@loom/workflow-runtime";

// ── T2 — the wire-level kernel ABI ────────────────────────────────────────────
//
// A versioned wire protocol that is a PROJECTION of the K1 syscall ABI —
// normative for WIRE CLIENTS ONLY. The TypeScript `ctx` surface (K1) stays
// authoritative for in-process userland; this is derived FROM it, never the
// reverse (the amendment's A1 — no authority inversion). Because the projection
// is generated from `KERNEL_SYSCALLS`, it cannot silently drift from the real
// syscall set (a conformance test pins the derivation).

/**
 * The wire protocol's own version. Independent of `KERNEL_ABI_VERSION` but
 * tracks its major line: a wire client negotiates on this, and the projection
 * it wraps is pinned by the `kernelAbiVersion` it reports.
 */
export const WIRE_ABI_VERSION = "1.0.0";

/**
 * Wire semantics for a syscall (A2): a **unary** call is request→response; a
 * **channel** call carries an incremental stream (`stream`, `ui`) and needs a
 * streaming transport frame. Partitioning these BEFORE choosing JSON-RPC vs gRPC
 * is what the amendment requires — this table is that partition.
 */
export type WireSemantics = "unary" | "channel";

export interface WireMethod {
  /** The JSON-RPC method name — the syscall namespaced under `ctx.`. */
  method: string;
  /** The K1 syscall this method projects. */
  syscall: string;
  semantics: WireSemantics;
  since: string;
}

const CHANNEL_SYSCALLS = new Set(["stream", "ui"]);

/**
 * Derive the wire-method table from the authoritative K1 syscalls. Generated,
 * not hand-maintained, so the wire ABI is provably a projection of the kernel
 * ABI (T2.1). `ui` is a K1 accessor (a property object) — on the wire it is a
 * channel namespace whose sub-operations stream UI patches.
 */
export function deriveWireMethods(syscalls: readonly KernelSyscall[] = KERNEL_SYSCALLS): WireMethod[] {
  return syscalls.map((s) => ({
    method: `ctx.${s.name}`,
    syscall: s.name,
    semantics: CHANNEL_SYSCALLS.has(s.name) ? "channel" : "unary",
    since: s.since,
  }));
}

export const WIRE_METHODS: readonly WireMethod[] = deriveWireMethods();

/**
 * The client-facing CARRIER operations (T2.4) — what a non-TS client actually
 * calls to drive an execution over the wire. The kernel folds and stays
 * authoritative for state; the client starts/resumes/reads. Suspended executions
 * are re-driven by the KERNEL (server-side flow code), which is why the staged
 * A2A/worker carrier sidesteps the "who re-drives" problem (A3): the client's
 * surface is task-shaped, not per-syscall.
 */
export const CARRIER_METHODS = [
  "execution.start",
  "execution.resume",
  "execution.getState",
  "execution.cancel",
] as const;

export type CarrierMethod = (typeof CARRIER_METHODS)[number];

/** The wire ABI descriptor a server advertises (mirrors `KERNEL_ABI`). */
export interface WireAbi {
  wireVersion: string;
  kernelAbiVersion: string;
  syscalls: readonly WireMethod[];
  carrier: readonly string[];
}

export const WIRE_ABI: WireAbi = {
  wireVersion: WIRE_ABI_VERSION,
  kernelAbiVersion: KERNEL_ABI_VERSION,
  syscalls: WIRE_METHODS,
  carrier: CARRIER_METHODS,
};

// ── JSON-RPC 2.0 framing ──────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** JSON-RPC error codes used by the carrier (standard + kernel-specific). */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** A kernel ring denied the operation (K2/K3/K6/K7/K12) or it otherwise failed. */
  kernelRefused: -32000,
} as const;
