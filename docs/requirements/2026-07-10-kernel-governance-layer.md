# Kernel Governance Layer — Requirements (Maturity, Fitness, Specification, Compatibility)

> **Status:** Proposal / gap analysis
> **Evaluated:** 2026-07-10 — the normative verdicts + the unifying design live in the
> [critical evaluation](2026-07-10-kernel-governance-layer-evaluation.md). This doc stays verbatim.
> **Recorded:** 2026-07-10 (captured verbatim for record/history)
> **Framing (author's):** "If Loom is becoming an execution kernel, the project now needs concepts
> that Linux, Kubernetes, and LLVM all have" — a capability maturity model, executable
> architectural fitness functions, a kernel specification separate from the ADRs, and a machine-
> readable compatibility matrix.

---

## Proposal 1 — Capability Maturity

Today the document effectively has: Requirement → Shipped → Delta. Evolve this into a formal
maturity model. Example ladder:

| Level | Meaning |
|---|---|
| L0 | Concept accepted |
| L1 | Experimental implementation |
| L2 | Stable implementation |
| L3 | Production-ready |
| L4 | Verified & benchmarked |
| L5 | ABI guaranteed |

Then every subsystem gets a maturity badge. Example:

| Capability | Level |
|---|---|
| Workflow Runtime | L5 |
| Replay VM | L5 |
| Event Store | L5 |
| Verification | L4 |
| Decision Graph | L4 |
| Runtime Intelligence | L3 |
| Placement Adapters | L2 |
| GPU Worker | L1 |

Now contributors immediately know where investment is needed.

## Proposal 2 — Architectural Fitness Functions

The document already talks about deterministic replay, minimal kernel, G2, P10. Make them
executable. Every PR should prove: ✓ Replay unchanged; ✓ ABI unchanged; ✓ Event schema compatible;
✓ Zero overhead when disabled; ✓ Benchmarks passed; ✓ Conformance passed; ✓ Compiler validation
passed. These become architectural fitness functions, continuously enforcing the kernel's design
rather than relying on reviewer memory.

## Proposal 3 — Loom Kernel Specification

The project is now large enough that it deserves a document equivalent to a language specification.
A **Loom Kernel Specification** would define: execution model, replay semantics, event model,
suspension semantics, placement semantics, SPI contracts, resource semantics, compatibility
guarantees. The ADRs then describe *why* decisions were made, while the Kernel Specification
describes *what* is guaranteed. That separation is valuable because implementers, adapter authors,
and downstream frameworks (GenUI, AetherOS) can rely on a stable contract without reading dozens of
ADRs.

## Proposal 4 — Requirement: Kernel Compatibility Matrix

**Problem.** As Loom accumulates SPI versions, event schema versions, ABI versions, placement
adapters, and compiler versions, it becomes harder to know what combinations are supported.

**Requirement.** Loom shall publish a machine-readable compatibility matrix describing supported
combinations of: Kernel ABI, Event Schema, Compiler Version, SPI Version, Placement Adapter, Worker
Runtime, Projection Runtime.

**Why it belongs in Loom.** Compatibility is a kernel responsibility. It is not application policy.

**Success criteria.** Every release produces a compatibility matrix automatically. Tooling
validates compatibility before deployment. This complements the verification work without changing
execution semantics.
