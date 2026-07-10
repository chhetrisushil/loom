# Execution-Kernel Forward Requirements (5–10 year) — Requirements

> **Status:** Proposal / affirmative roadmap
> **Evaluated:** 2026-07-10 — assessed as an **acceptance record** against the shipped kernel;
> the normative verdicts and deltas live in the
> [critical evaluation](2026-07-10-execution-kernel-forward-requirements-evaluation.md).
> This document stays verbatim as the historical record.
> **Recorded:** 2026-07-10 (captured verbatim for record/history)
> **Audience:** Loom maintainers; platform teams evaluating Loom as the execution kernel for autonomous systems
> **Framing (author's):** The earlier critique was primarily *defensive* — "don't add X because it
> violates the kernel philosophy." This is the *affirmative* counterpart: **if Loom wants to become
> the execution kernel for autonomous systems over the next 5–10 years, what new capabilities
> should it add without violating its principles?** The requirements below are written to satisfy
> the **four invariants** (minimal kernel, deterministic replay, zero-cost when unused, strict
> mechanism vs. policy separation) and to avoid reintroducing abstractions Loom deliberately
> removed (e.g. fibers). Each is argued for **kernel ownership** and against belonging in GenUI /
> AetherOS, and each satisfies three tests: **kernel ownership**, **determinism**, **composability**.

---

## Requirement 1 — Runtime Verification Framework

**Priority:** P0

**Problem.** Today, most runtime errors are discovered only after an execution starts — e.g. a
non-deterministic effect, unsupported placement, missing capability, invalid suspend point,
incompatible resource budget. All of these are detectable *before* execution. Discovering them
late increases production failures, replay failures, and debugging effort.

**Requirement.** Loom shall provide a Runtime Verification Framework capable of validating an
execution before dispatch. Verification shall include: deterministic replay safety; suspension
safety; placement compatibility; capability compatibility; resource compatibility; event schema
compatibility; ABI compatibility.

**Why this belongs in Loom.** Verification protects execution semantics. It is not application
logic and not policy. It directly protects the kernel invariant of deterministic execution.
**Why not AetherOS:** AetherOS may define additional policies, but only Loom understands replay,
event folding, execution ABI, and suspension invariants — so verification belongs in the kernel.

**Success criteria.** Invalid executions never start; verification rules are pluggable; the
compiler performs static verification where possible; the runtime performs dynamic verification
where required.

## Requirement 2 — Runtime Observability Framework

**Priority:** P1

**Problem.** Telemetry exists; execution *understanding* does not. Developers cannot easily answer:
why was an execution slow? which capability dominated latency? what caused replay cost? where are
the suspension bottlenecks?

**Requirement.** Loom shall expose a first-class Runtime Observability Framework providing:
execution timeline; replay timeline; suspend/resume timeline; capability latency; resource
utilization; replay cost; scheduler metrics.

**Why this belongs in Loom.** Only Loom has visibility into the execution lifecycle, the event
journal, the replay engine, and the scheduler. No higher layer can reconstruct these accurately.

**Success criteria.** Developers can inspect execution without modifying application code;
observability is read-only; disabled observability has zero measurable runtime overhead.

## Requirement 3 — Decision Materialization

**Priority:** P1

**Problem.** Loom records decisions; applications cannot easily query them. Decision history
remains embedded inside execution history.

**Requirement.** Loom shall materialize decisions into queryable read models — exposing a
`DecisionStore`, `DecisionGraph`, and `DecisionHistory`. Each decision shall optionally include
alternatives, confidence, latency, cost, selected alternative, and outcome.

**Why this belongs in Loom.** Decision recording already exists; materialization is a projection
concern and does not alter deterministic execution.

**Success criteria.** Decision projections remain replayable; decision projections are disposable;
execution history remains canonical.

## Requirement 4 — Runtime Introspection API

**Priority:** P2

**Problem.** Execution information is scattered across runtime internals; tooling currently
reconstructs relationships.

**Requirement.** Loom shall expose a unified read-only Runtime Introspection API exposing:
execution graph; dependency graph; decision graph; placement graph; resource graph.

**Why this belongs in Loom.** Introspection exposes kernel state; it does not execute logic; it
enables tooling without exposing implementation details.

**Success criteria.** Every graph derives entirely from runtime state; applications cannot mutate
the runtime through the API.

## Requirement 5 — Resource Dimensions

**Priority:** P2

**Problem.** Current resource management focuses primarily on execution cost; modern autonomous
systems operate under multiple constraints.

**Requirement.** Loom shall support extensible runtime resource dimensions — e.g. execution time,
memory, network, token consumption, monetary cost. Resource dimensions shall remain optional.

**Why this belongs in Loom.** Resources influence scheduling and admission; they do not encode
application policy.

**Success criteria.** New dimensions are pluggable; existing applications continue working
unchanged.

## Requirement 6 — Placement Adapter Framework

**Priority:** P2

**Problem.** Placement abstraction exists; additional execution targets require custom
implementations.

**Requirement.** Loom shall standardize the Placement Adapter SPI. Supported implementations may
include Kubernetes, Lambda, GPU workers, Edge workers. The kernel shall remain placement-agnostic.

**Why this belongs in Loom.** Placement is a kernel concern; cloud-provider logic is not.

**Success criteria.** Adding a new backend requires implementing the SPI only; no kernel changes.

## Requirement 7 — SPI Conformance Framework

**Priority:** P3

**Problem.** Extension SPIs exist but do not all share a uniform validation model; third-party
implementations risk subtle incompatibilities.

**Requirement.** Loom shall provide a conformance framework for every public SPI. Each SPI shall
define a behavioral contract, compatibility rules, a versioning policy, and automated conformance
tests.

**Why this belongs in Loom.** SPIs define the kernel boundary; compatibility must be enforced by
the kernel.

**Success criteria.** Third-party implementations can self-certify; kernel upgrades preserve
compatibility guarantees.

## Requirement 8 — Advisory Optimization Pipeline

**Priority:** P3

**Problem.** Optimization capabilities exist but are exposed through multiple independent
components. There is no unified lifecycle for observing, analyzing, recommending, and evaluating
optimizations.

**Requirement.** Loom shall provide an optional Advisory Optimization Pipeline that composes
existing advisory components into a coherent flow: observe execution telemetry → analyze historical
behavior → produce optimization recommendations → record recommendation outcomes → feed outcomes
back into future recommendations. The pipeline shall remain advisory only.

**Why this belongs in Loom.** Optimization recommendations derive from runtime behavior; execution
semantics remain unchanged; application code decides whether to adopt recommendations.

**Success criteria.** Recommendations are reproducible; recommendations never influence replay;
applications may disable the pipeline without affecting execution.

---

## Why these requirements are stronger (author's rationale)

Compared with the original (defensive) recommendations, these are deliberately **kernel-centric**.
They avoid introducing new execution abstractions (such as fibers), avoid duplicating existing
capabilities (such as placement or decision recording), and instead strengthen Loom where only the
kernel has unique knowledge. Each requirement satisfies three tests:

1. **Kernel ownership** — the capability depends on execution semantics that only Loom can provide.
2. **Determinism** — the capability cannot change replay or event folding.
3. **Composability** — it is additive and optional, preserving Loom's minimal-kernel philosophy.

This framing argues not just *what* should be built, but *why the capability belongs in Loom
instead of GenUI or AetherOS*, grounding each requirement in the kernel's responsibilities rather
than in product ambitions.
