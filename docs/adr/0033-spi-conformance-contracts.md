# ADR 0033 — SPI consolidation + conformance contracts

- Status: Proposed (2026-07-10) — accepted item #6 in the [Execution-OS evaluation](../requirements/2026-07-10-execution-operating-system-evaluation.md)
- Date: 2026-07-10
- Builds on: [ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md) (K1 kernel ABI + conformance test, K5 event-schema governance), the existing store / dispatcher / worker / effect / scheduler SPIs

## Context

Loom's extensibility ("Kernel Extensions" + "Runtime Contracts", P3) is **mostly shipped**: there
are already pluggable SPIs for event store, snapshot store, branch registry, dispatcher, worker
runtime, effect, scheduler, and warmer, and K1/K5 give the *syscall* surface a versioned contract
plus a conformance test. Two gaps remain:

1. The SPIs are documented **unevenly** — each in its own package, no single map of "here is every
   replaceable seam and its contract."
2. Only the K1 syscall ABI and K5 event schema have **conformance tests**. The placement, memory,
   projection, and capability SPIs have interfaces but no portable test suite a third-party
   implementation can run to prove it conforms.

## Decision

- **C1 — one SPI map.** A single doc (`docs/loom-2.0/`) enumerating every extension seam
  (scheduler, placement, memory, decision, projection, transport, persistence, capability, auth,
  policy, tracing), its interface, its invariants, and its reference impl — the "kernel extension
  model" the requirements asked for, as documentation over the SPIs that already exist.
- **C2 — conformance kits.** Extend the K1/K5 conformance-test pattern to each SPI: a shared
  `@loom/testing` suite (`runEventStoreConformance(factory)`, `runDispatcherConformance(factory)`,
  …) that any implementation imports and runs against itself. Makes third-party runtimes *provable*,
  not just possible.

No new kernel mechanism — this is consolidation + test scaffolding over the existing seams.

## Consequences

- Third parties can implement a store/dispatcher/memory backend and *prove* conformance in CI.
- Kernel genericity strengthened (P10): the contract, not the reference impl, becomes normative.
- No runtime overhead — pure docs + test kits.

## Verification

- Each conformance kit passes against Loom's own reference impls and fails a deliberately-broken
  stub.
- The SPI map lists every seam with a link to its interface and a reference impl.

## Amendments (from the Execution-OS evaluation)

- Merges the requirements' "Kernel Extensions" (mostly shipped) and "Runtime Contracts" (partial)
  into one consolidation item; "Fiber Contract" dropped (fibers rejected).
