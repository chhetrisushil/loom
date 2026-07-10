# ADR 0026 — T2: wire-level kernel ABI (language neutrality)

- Status: Accepted (implemented 2026-07-10 — `@loom/wire-abi`: `WIRE_ABI` is a versioned
  JSON-RPC **projection** of the K1 syscalls, *generated from* `KERNEL_SYSCALLS` (T2.1 — the
  TS surface stays authoritative, no inversion), partitioned unary vs channel (`stream`/`ui`)
  per T2.2; a pure `handleRpc(runtime, request)` carrier drives executions
  (`execution.start`/`resume`/`getState`/`cancel`) with all rings running kernel-side of the
  wire; language-agnostic fold-conformance vectors (`FOLD_VECTORS` + `runFoldVectors`, plain
  JSON any client can run) extend the K1/K5 pins (T2.3); the acceptance test drives a
  suspend/resume/replay from a raw-JSON HTTP client with the fold byte-identical to an
  in-process run. Staged as its own carrier; A2A/worker-server mounting is a follow-up (T2.4).
  Amendments below applied.)
- Date: 2026-07-10
- Requirements: [T2 in the kernel-hardening requirements](../requirements/2026-07-10-kernel-hardening-k7-k12-t1-t2.md#t2--wire-level-kernel-abi-language-neutrality) — priority **P3**

## Context

K1's syscall ABI is a set of TypeScript interfaces pinned by an in-process conformance test.
Real kernel ABIs are wire-level: any language can make a syscall. Until then, "userland"
means "TypeScript userland," which caps the platform ambition. Strategic rather than
blocking — hence P3, staged last.

## Decision

Lift the K1 ABI from TypeScript interfaces to a versioned wire protocol, keeping every ring
on the kernel side of the wire:

- The eight K1 syscalls (`execute / run / decide / parallel / suspend / emit / stream / ui`)
  are specified as a versioned wire protocol (JSON-RPC or gRPC) that is a **projection of
  the K1 ABI, normative for wire clients only** — the shipped TypeScript `ctx` surface
  (ABI 1.0.0, pinned) remains authoritative for in-process userland (T2.1 as amended; the
  requirement's "TS re-derived from the wire spec" is an authority inversion over a stable
  surface — see Amendments).
- A remote tool/agent speaking the wire ABI is subject to the same rings — K2 authorize,
  K3 meter, K6 validate, K7 egress — as an in-process one: the rings live on the kernel side
  of the wire, so a foreign-language client gains no bypass (T2.2).
- Conformance is executable: a language-agnostic test-vector suite (event-log fixtures in,
  expected folds out) that any client implementation can run, extending the existing K1/K5
  conformance pins (T2.3).
- Staging: the A2A server is the natural first carrier — it already speaks HTTP + agent
  cards; the ABI generalizes it from "tasks" to the full syscall set (T2.4).

## Acceptance criteria

A minimal non-TypeScript client (even a shell script against JSON-RPC) starts, suspends,
resumes, and replays an execution, with all ring verdicts enforced kernel-side and the fold
byte-identical to the TS client's.

## Consequences

- "Userland" stops meaning "TypeScript userland": tools and agents in any language become
  first-class kernel clients, with K7's isolation boundary
  ([ADR 0019](0019-k7-data-plane-isolation-and-egress-control.md)) as a natural shared seam.
- No new durable facts; the on-disk schema (K5) is unchanged. The wire protocol carries its
  own version, mirroring `KERNEL_ABI_VERSION`.
- Unwired (no wire clients), behavior is byte-identical (G2) — in-process callers keep the
  serialization-free fast path; there is no wire tax on TS userland.

## Amendments (code-grounded evaluation, 2026-07-10)

Adopted per the [T2 evaluation](../requirements/2026-07-10-kernel-hardening-evaluation.md#t2--wire-level-kernel-abi--accept-as-staged-p3-with-amendments)
(verdict: **Accept as staged (P3), with amendments**):

- **A1 — authority corrected** (applied inline above): the wire protocol is a versioned
  *projection* of the K1 ABI, normative for wire clients only. Re-deriving the shipped,
  pinned TS surface from a wire spec would churn a stable ABI and degrade the hand-written
  `ctx` DX for zero user benefit.
- **A2 — syscall semantics partition**: before choosing JSON-RPC vs gRPC, the spec
  partitions the eight syscalls into unary (`execute/run/decide/parallel/suspend/emit`) vs
  **channel** (`stream`, `ui`) semantics — the channel pair drives the transport decision.
- **A3 — who re-drives**: the spec must define resumption ownership for wire clients — the
  kernel folds and stays authoritative for state; the *client* re-drives flow logic after
  resume, so suspended wire executions need a client-reconnect contract, and a resume with
  no connected driver parks durably and visibly. This is the hard problem; the A2A staging
  (T2.4) is the right first carrier precisely because its task-shaped surface avoids it
  initially.
