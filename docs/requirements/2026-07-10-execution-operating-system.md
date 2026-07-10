# Loom Execution Operating System — Requirements (Next-Version Proposal)

> **Status:** Proposal / gap analysis
> **Evaluated:** 2026-07-10 — items assessed under a **strict-gatekeeper** code-grounded
> review; the normative verdicts (accept / partial / reject / already-shipped) and factual
> corrections live in the [critical evaluation & amendments](2026-07-10-execution-operating-system-evaluation.md).
> This document stays verbatim as the historical record.
> **Recorded:** 2026-07-10 (captured verbatim for record/history)
> **Audience:** Loom maintainers; platform teams evaluating Loom as the execution kernel for autonomous systems
> **Decision records:** accepted items each get a proposal ADR — see the evaluation doc's
> "Recommended net-new scope" for the ADR/issue mapping (ADRs 0028+).
> **Prior art:** the shipped runtime this proposal builds on is documented in
> [Loom 2.0 overview](../loom-2.0/00-overview.md) and ADRs
> [0016](../adr/0016-loom-2.0-execution-runtime-and-decision-seam.md)–[0027](../adr/0027-advisory-pre-warming.md).
> **Framing (author's):** "The next version should not primarily add more capabilities. It
> should make the existing capabilities compose into what is effectively an Execution
> Operating System." The items below are written as product requirements, not implementation
> tasks.

Two global constraints from the existing architecture apply to every item (as in the
kernel-hardening series):

- **(G1)** MUST preserve P2 (deterministic, pure replay) and P9 (non-determinism only when logged).
- **(G2)** MUST be additive and opt-in (P10): unwired, behavior is byte-identical to Loom 2.0.

---

## Priority 0 — Execution Fiber Runtime

**Current state.** Execution is still fundamentally modeled as a workflow. Although the
scheduler, replay runtime, dispatcher and execution journal are mature, the runtime still
thinks in terms of "running a workflow."

**Requirement.** Introduce **Execution Fibers** as the fundamental execution primitive.
Everything becomes a fiber: workflow, agent, planner, capability, tool, UI interaction,
background task, subscription, long running watch.

A fiber should support: suspend, resume, migrate, snapshot, replay, clone, cancel, fork,
merge (optional).

Every execution API should operate on fibers rather than workflows. This would unify the
entire runtime.

## Priority 0 — Decision Runtime

The repository now has the beginnings of advisory/decision capabilities. Make this a
first-class runtime. Every autonomous system continuously makes decisions. Today Loom records
execution. It should also record decisions.

**Example — per decision:** Context; Alternatives; Policy evaluation; Estimated cost; Latency;
Confidence; Chosen alternative; Observed outcome; Learning signal.

The runtime should expose: DecisionStore; DecisionGraph; DecisionPolicy; DecisionEvaluator;
DecisionReplay; DecisionAnalytics; DecisionOptimization.

This becomes the foundation for explainability.

## Priority 0 — Predictive Scheduler

**Current scheduler:** schedule → execute.

**Desired scheduler:** observe → predict → prefetch → warm → speculate → execute → correct.

The scheduler should become CPU-like.

**Capabilities:** branch prediction; speculative execution; execution prefetch; capability
warming; worker warming; cache warming; execution prioritization; locality awareness;
placement prediction.

## Priority 1 — Unified Runtime Context

Today execution context contains execution state. It should become the operating system
context: Execution; Decision; Memory; Knowledge; Capabilities; Identity; Security; Resources;
Telemetry; Policies; Observability; Placement; Scheduler; Time.

Every runtime component receives exactly one context.

## Priority 1 — Runtime Resource Manager

Currently resources are implicit. Need explicit runtime resources: CPU budget; Token budget;
Memory budget; Latency budget; Cost budget; Network budget; Energy budget; Capability budget.

Execution can negotiate resources dynamically.

## Priority 1 — Unified Memory Runtime

Memory is currently separate. It should become a runtime:

Working Memory → Execution Memory → Session Memory → User Memory → Semantic Memory →
Long-term Memory → Knowledge Graph.

Every execution accesses memory through one interface.

## Priority 1 — Placement Runtime

Cloud Run support is a great start. Generalize into Placement Runtime: Local; Cloud Run;
Kubernetes; Lambda; Edge; Browser; Mobile; Remote Worker; GPU; WASM.

Placement becomes another optimization dimension.

## Priority 1 — Execution Migration

Currently execution resumes. Need live migration:

Worker A → pause → serialize → transfer → Worker B → resume.

Eventually: Cloud Run → Kubernetes → Edge → Browser, without execution changes.

## Priority 1 — Runtime Introspection

The runtime currently exposes execution. Need runtime inspection APIs: Execution Graph; Fiber
Graph; Capability Graph; Decision Graph; Resource Graph; Dependency Graph; Scheduler Graph;
Placement Graph.

Everything becomes inspectable.

## Priority 2 — Runtime Cache Hierarchy

Rather than independent caches, create hierarchy: L1 Execution; L2 Capability; L3 Tool; L4
Memory; L5 Knowledge; L6 Model; L7 Projection.

Scheduler manages cache locality.

## Priority 2 — Adaptive Runtime

Execution currently deterministic. Need adaptive optimization. Runtime continuously learns:
Planner selection; Tool selection; Capability ordering; Model selection; Prompt optimization;
Execution scheduling; Worker placement; Branch prediction — without changing deterministic
replay.

The optimization layer should remain advisory and produce durable recommendations rather than
mutating execution semantics.

## Priority 2 — Event Streams become Time

Events are treated as history. Treat them as time. Runtime should expose: Past; Present;
Future; Simulation; Alternative timelines; Predicted timeline.

This naturally extends branching.

## Priority 2 — Digital Twin Runtime

One capability I don't see yet. Every execution should optionally have a twin:

Real execution → Twin execution → Prediction → Optimization → Recommendation.

Useful for Autonomous Cloud.

## Priority 2 — Runtime Observability

Current telemetry is good. Need runtime diagnostics: Fiber timeline; Execution flame graph;
Capability latency; Decision latency; Replay cost; Suspend latency; Resume latency; Scheduler
efficiency; Cache hit ratio; Prediction accuracy.

Think Chrome DevTools for Loom.

## Priority 3 — Kernel Extensions

Today extensions are packages. Need kernel extension model: Scheduler; Placement; Memory;
Decision; Projection; Transport; Persistence; Capability; Authentication; Policy; Tracing.

Everything should be replaceable without modifying Loom.

## Priority 3 — Runtime Contracts

Introduce explicit runtime contracts: Capability Contract; Fiber Contract; Execution Contract;
Decision Contract; Placement Contract; Memory Contract; Projection Contract; Scheduler
Contract.

Makes third-party runtimes possible.

## Priority 3 — Runtime Verification

Runtime should verify before execution: determinism; replay safety; suspension safety;
migration safety; capability compatibility; placement compatibility; resource compatibility.

## Priority 3 — Autonomous Optimization Loop

Finally, Loom should close the loop:

Observe → Analyze → Predict → Optimize → Execute → Evaluate → Learn → Repeat.

Not inside planners. Inside the execution operating system itself.

---

## Requirements that should NOT move into Loom

Consistent with the architectural boundary already established, keep these out of Loom:

- Blueprint authoring
- UI layout and rendering
- React/Angular/Flutter integration details
- Design systems
- Domain-specific cloud operations (GKE, Cloud SQL, AlloyDB, AWS, Azure, etc.)
- Marketplace, governance, billing, and fleet management

Those belong in **GenUI** (experience and application framework) and **AetherOS** (autonomous
cloud platform), while Loom remains the reusable execution substrate.

## Overall assessment (author's)

Compared to the first review, the project has crossed an important threshold. It already has
the characteristics of a durable execution kernel rather than a traditional workflow engine.
The remaining gaps are less about adding features and more about elevating the abstraction
level.

One-sentence summary of the proposed next major evolution:

> "Evolve Loom from a durable workflow runtime into a true execution operating system, where
> fibers, decisions, placement, resources, memory, and optimization are all first-class
> runtime concepts built around a deterministic execution kernel."

Direction intended to be aligned with the long-term boundary: **Loom owns execution, GenUI
owns experience, and AetherOS owns autonomous operations.**
