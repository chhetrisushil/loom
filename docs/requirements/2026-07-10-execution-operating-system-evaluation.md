# Execution Operating System — Critical Evaluation & Amendments

> **Status:** Adopted — this evaluation amends the [recorded requirements](2026-07-10-execution-operating-system.md)
> and drives ADRs [0028](../adr/0028-runtime-verification.md)–[0033](../adr/0033-spi-conformance-contracts.md).
> **Date:** 2026-07-10
> **Stance:** strict gatekeeper — the minimal-kernel (P10) and deterministic-replay (P2/P9)
> invariants are defended hard; items that revive deliberately-dropped designs or restate
> shipped capabilities are rejected outright rather than softened.
> **Method:** every factual premise in the requirements was verified against the actual source
> (execution primitive, decision seam, metering, memory tiers, placement, advisory plane,
> kernel ABI, introspection, branching). The original requirements doc stays verbatim (it is
> the historical record); the **normative verdicts live here** and in each ADR's Amendments
> section.

## The four non-negotiables

Every requirement was tested against these; a requirement that could not be amended to pass
all four was rejected.

1. **Kernel genericity** — Loom remains a generic execution kernel for *any* intelligent
   system. The kernel carries mechanisms; policy content (which targets, which budgets, which
   models) always lives above it (P10).
2. **Developer experience is THE priority** — every new capability surfaces through an existing
   idiom: one optional `defineConfig` key, one `ctx.*` method, one `flow$`/`tool$` option, or
   one read-only lens. The bar is loom-starter's ~10-line wiring. No new ceremony.
3. **Performance** — Loom's own hot path is not compromised. Zero-overhead-when-unwired (G2)
   stays *benchmark-provable* (`pnpm bench`); every landed item ships an unwired-vs-wired bench.
4. **Safety & security for apps on Loom** — enforcement sits where it cannot be bypassed, and
   *nothing an optimizer suggests may mutate the deterministic fold*. A cache or prediction that
   can feed replay is not an optimization, it is a determinism bug.

## The one finding that dominates everything

**The "Execution OS" already largely exists.** Loom 2.0 (M1–M11 + K1–K12 + T1–T2) already
delivers a hardened, ABI-versioned kernel with pluggable SPIs, a decision seam, an advisory
optimization plane, tiered memory, placement dispatch, and branching. So the correct next
version is **not a build phase** — it is mostly **framing/consolidation + a short list of
genuinely-new gaps.** Several P0 items restate shipped capabilities or revive things ADR 0016
deliberately dropped. Net-new, worth-building work is ~6 items, none of them the headline P0s.

## Verdict summary

| # | Item | Verdict | Priority | The one line that mattered |
|---|---|---|---|---|
| P0 | Execution Fiber Runtime | **REJECT (revival)** | — | ADR 0016 dropped fibers: two sources of truth for durable pause/resume + determinism hazard. Every listed op already exists at *execution* level (M1 tasks + `ctx.execute`); `migrate`=resume; `merge` already rejected. No new capability named. |
| P0 | Decision Runtime | **PARTIAL ACCEPT** | P1 | Recording/replay/analytics/feedback already shipped. New: materialized `DecisionStore`/`DecisionGraph` read-model + richer `DECISION_RECORDED` payload. Must stay advisory. → ADR 0030 |
| P0 | Predictive Scheduler | **MOSTLY REJECT, narrow accept** | P3 | Speculation dropped (P2); warming already exists. Accept only *advisory* warm/placement prediction fed by analytics. Reject speculative/effect-running branch prediction. → folded into ADR 0029/0032 advisory lenses |
| P1 | Unified Runtime Context | **REJECT as framed** | — | Split `ExecutionContext`/`EffectContext` is deliberate (P10 sparse PCB; distinct trust boundaries; G2). A god-context fights the minimal kernel. At most a typed accessor facade (see ADR 0031). |
| P1 | Runtime Resource Manager | **PARTIAL ACCEPT** | P2 | Metering+quota shipped (tokens/cost/ms). New: memory/wall/network dimensions where enforceable + *bounded* advisory negotiation via the decision seam. Drop "energy budget" (unmeasurable in-kernel). → ADR 0032 |
| P1 | Unified Memory Runtime | **MOSTLY SHIPPED** | P3 | `TieredMemory` already covers working/episodic/semantic/procedural + promote/summarize + deterministic recall. Accept only: unify access interface + formalize scopes. KG & vectors belong to AetherOS. |
| P1 | Placement Runtime | **ACCEPT (incremental)** | P2 | Already a runtime (`PlacementDispatcher` + `WorkerRuntime` SPI). K8s/Lambda/GPU/WASM = adapters, no kernel change. Build on demand. → tracking issue only |
| P1 | Execution Migration | **REJECT as framed** | — | Resume *is* migration in the stateless-worker model: any worker rebuilds from journal, fencing (K9.4) kills zombies, `EXECUTION_MIGRATED` exists. Live mid-effect migration = large cost, goal already met. |
| P1 | Runtime Introspection | **PARTIAL ACCEPT** | P2 | Graph/lineage/history/decisions already queryable. New & low-risk: a programmatic read-only introspection facade over execution/task/decision/resource/placement/dependency graphs. → ADR 0031 |
| P2 | Runtime Cache Hierarchy | **MOSTLY REJECT** | — | L1–L7 unified cache is unsafe in a deterministic-replay system (a cache must never feed the fold). Accept at most an opt-in memoization middleware for idempotent effects. |
| P2 | Adaptive Runtime | **ALREADY SHIPPED** | — | Literally M9–M11 + `rankedRouter` under P9/P10. The reviewer's own constraint = the current design. Incremental = more lenses. |
| P2 | Event Streams → Time | **COSMETIC (already there)** | — | `BranchRegistry` + `foldAt` already give past/present/simulation/alternative timelines. Doc reframe + optional thin `timeline` sugar. |
| P2 | Digital Twin Runtime | **DEFER (mostly AetherOS)** | — | fork-then-diverge already *is* a twin. Autonomous-cloud twinning belongs to AetherOS. Defer unless a concrete Loom-level use appears. |
| P2 | Runtime Observability | **ACCEPT (DX)** | P1 | Genuinely missing: flame-graph/timeline profiler, suspend/resume/replay-cost breakdowns, hit-ratio/prediction-accuracy metrics. Read-only over log+telemetry. → ADR 0029 |
| P3 | Kernel Extensions | **MOSTLY SHIPPED** | P3 | SPIs already exist. Accept as consolidation: uniformly document + fill gaps against the existing pattern. → folded into ADR 0033 |
| P3 | Runtime Contracts | **PARTIAL ACCEPT** | P3 | K1 ABI + K5 event schema + conformance tests already contract the syscall surface. Extend the conformance-test pattern to every SPI. → ADR 0033 |
| P3 | Runtime Verification | **ACCEPT (new, best ROI)** | P0 | No pre-flight verifier exists. Checking determinism/replay/suspension/placement/resource compat *before* execution is genuinely new, fits the kernel, raises safety. Partly static via `@loom/compiler`. → ADR 0028, `@loom/verify` |
| P3 | Autonomous Optimization Loop | **PARTIAL (mostly there)** | P3 | observe→analyze→predict→optimize→evaluate→learn already spans analytics + `runtimeIntelligence` + `rankedRouter` + outcomes. Accept: wire into one *optional advisory* loop. Reject any auto-mutation of semantics. |
| — | Out-of-Loom list (UI, blueprints, framework integ, domain cloud-ops, marketplace/billing/fleet) | **ENDORSE** | — | Correctly assigned to GenUI/AetherOS. Keep out. |

## Factual corrections (requirements vs. actual code)

The requirements were written against an assumed codebase; these premises are corrected before
any implementation planning. (Paths are absolute-in-repo.)

| Requirements claim | Reality | Consequence |
|---|---|---|
| P0-Fiber: "the runtime still thinks in terms of 'running a workflow'"; make **fibers** the fundamental primitive | `ADR 0016` **explicitly dropped** "everything executes as fibers": it "collides with the event-sourced suspend/resume that already owns durable pause/resume — two sources of truth for 'where am I.'" M1 already generalized the primitive from *steps* to *tasks* (`packages/core/src/types/definitions.ts` `TaskDefinition.kind`) with `ctx.execute(task)` (`packages/workflow-runtime`). | Fibers are a **revival with no new justification**. Every listed fiber op already exists at execution granularity (`start`/`resume`/`fork`/`suspend`/`cancel`/`replay`); `merge` was deliberately omitted (no principled join for divergent AI state). **Rejected.** |
| P0-Decision: "Today Loom records execution. It should **also** record decisions." | Decisions are already recorded: `ctx.decide`→`DECISION_RECORDED` (`packages/workflow-runtime/src/WorkflowContext.ts`), folded to `_decisions`; outcomes via `OUTCOME_RECORDED` + `packages/analytics`; ranking feedback via `rankedRouter` (`packages/reasoning/src/router.ts`). | The gap is not *recording* but **materialization**: no queryable `DecisionStore`/`DecisionGraph`, and the payload lacks alternatives/cost/latency/confidence. Scope narrows to a read-model + K5 payload extension. |
| P0-Scheduler: add "speculative execution" and "branch prediction" | Speculation was **explicitly dropped** (`ADR 0027`: "Loom 2.0 deliberately dropped speculative execution from the durable core. Pre-warming must therefore stay strictly in the advisory plane."). Warming already exists (`Warmer`/`Effect.warm`, `TimerService.warmLeadMs`). | Only the *advisory* warm/placement-prediction slice is accepted; speculative execution and effect-running branch prediction are **rejected** (violate P2). |
| P1-Context: "execution context contains execution state" → merge everything into one context | There are **two** deliberately-split contexts: `ExecutionContext` (`packages/workflow-runtime/src/types.ts`) and `EffectContext` (`packages/effect-runtime/src/types.ts`, carrying `signal`/`resources`/`principal`/`idempotencyKey`/`priority`). The PCB is intentionally sparse (P10). | A unified god-context **regresses** the minimal-kernel boundary and G2. Only a typed *accessor facade* is on the table. |
| P1-Resources: "resources are implicit" | Explicit already: `meteringMiddleware` (`packages/middleware/src/metering.ts`) meters tokens/cost/ms → `RESOURCE_METERED`/`QUOTA_EXCEEDED`; `EffectContext.resources`; cross-scope `nestedBudget.ts`. | Genuinely new is only *more dimensions* + *bounded* negotiation. "Energy budget" is unmeasurable in-kernel and dropped. |
| P1-Memory: "Memory is currently separate… make it a runtime" with tiers | `TieredMemory` (`packages/memory/src/TieredMemory.ts`) already implements working/episodic/semantic/procedural + `promote`/`summarize` + deterministic `recall` via `ctx.decide`. | Mostly shipped. Knowledge-graph & vector search are **AetherOS** concerns per the boundary; keep the `MemoryStore` SPI. |
| P1-Placement: "Cloud Run support is a great start. Generalize into Placement Runtime." | Already generalized: `PlacementDispatcher`/`SupervisingDispatcher` (`packages/dispatcher`) route over a `WorkerRuntime` SPI with local/remote/CloudRun impls; a WASM executor exists via T2 (`packages/wire-abi`). | New backends are **adapters against an existing SPI**, not a kernel change. Build on demand; browser/mobile/edge lean toward GenUI/AetherOS. |
| P1-Migration: "execution resumes… need live migration" | The stateless-worker model makes **resume equivalent to migration**: `ExecutionPackage` carries only coordinates, any worker rebuilds from `EventStore`+`SnapshotStore`, fencing (K9.4) fences zombies, `EXECUTION_MIGRATED` event exists. | Live mid-effect process migration adds large complexity for a goal already met. **Rejected as framed.** |
| P1-Introspection: "the runtime currently exposes execution" only | Already inspectable: CLI `logs`/`inspect`/`debug` + `buildTrace` (`packages/cli`), `TelemetryAdapter` (`packages/telemetry`), `BranchRegistry` lineage (`packages/event-runtime`). | Gap is a single *programmatic read-only facade*, not net-new inspection capability. |
| P2-Adaptive: "execution currently deterministic; need adaptive optimization" (advisory, durable recs, no mutation) | This is exactly M9–M11: `runtimeIntelligence`/`rankModels`/`rankedRouter` produce recommendations; choices logged via P9; replay untouched. | **Already shipped.** The reviewer's constraint *is* the current design. |
| P2-Time / P2-Twin: "events are history; treat as time / add digital twins" | `BranchRegistry` fork/promote + `ReplayVM.foldAt` already provide past/present/simulation/alternative timelines; fork-then-diverge is a twin. | Time = cosmetic reframe. Twin = mostly AetherOS. |

## Recommended net-new scope (the short list actually worth building)

Ranked by ROI-per-risk; each fits the four non-negotiables (advisory/read-only where it touches
optimization; kernel mechanism only where enforceable; unwired-zero-overhead). ADR + tracking
issue per item.

1. **Runtime Verification** — `@loom/verify`, pre-flight determinism/replay/suspension/
   capability/placement/resource checks; leans on `@loom/compiler` graph analysis. **P0.**
   → [ADR 0028](../adr/0028-runtime-verification.md)
2. **Runtime Observability / profiler** — flame-graph + latency-breakdown + hit-ratio lenses
   over log+telemetry; extends CLI `inspect`. **P1.** → [ADR 0029](../adr/0029-runtime-observability-profiler.md)
3. **Decision materialization** — `DecisionStore`/`DecisionGraph` read-model + richer
   `DECISION_RECORDED` payload (alternatives/cost/latency/confidence). **P1.**
   → [ADR 0030](../adr/0030-decision-materialization.md)
4. **Introspection facade** — one read-only API over execution/task/decision/resource/
   placement/dependency graphs. **P2.** → [ADR 0031](../adr/0031-runtime-introspection-facade.md)
5. **Resource dimensions + bounded negotiation** — memory/wall/network metering where
   enforceable; advisory request-more-within-ceiling logged as a decision. **P2.**
   → [ADR 0032](../adr/0032-resource-dimensions-bounded-negotiation.md)
6. **SPI consolidation + conformance contracts** — document every extension SPI uniformly and
   extend the K1/K5 conformance-test pattern to placement/memory/projection/capability. **P3.**
   → [ADR 0033](../adr/0033-spi-conformance-contracts.md)
7. *(demand-driven)* **Placement adapters** (K8s/Lambda/GPU) against the existing SPI —
   tracking issue only, no ADR yet.

**Explicit rejects:** Execution Fibers (revival), Live Migration (resume already is migration),
L1–L7 Cache Hierarchy (unsafe under deterministic replay), Speculative execution (P2), Unified
god-context (anti-minimal-kernel), Knowledge-graph in Loom (AetherOS boundary).

**Already shipped / reframe-only:** Adaptive Runtime, most of Decision recording, most of
Memory, Time-as-events, pre-warming / capability-&-worker warming.

## Sequencing

Verification (0028) first — it is the highest-ROI net-new item and its rules double as
executable specifications of the invariants the other items must not break. Observability (0029)
and Decision materialization (0030) next (both read-only lenses, independent). Introspection
(0031) unifies the query surface across 0029/0030. Resources (0032) and SPI conformance (0033)
last. Placement adapters are pulled only by concrete demand.
