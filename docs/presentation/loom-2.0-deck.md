---
marp: true
theme: default
paginate: true
title: "Loom 2.0 — The Execution Kernel for Intelligent Software"
---

<!-- _paginate: false -->

# Loom 2.0

### From a durable *workflow runtime* to the **execution kernel for intelligent software**

**execution seam · decision seam · reasoning · memory · scale-out · a real kernel (ABI · protection · accounting · supervision)**

<!--
Presenter: ~25 min. This deck tells the 2.0 story: the reframe, the honest critique,
the two spines, the runtimes, and why Loom now genuinely earns "kernel".
Deep-dive docs: docs/loom-2.0/. Decision record: docs/adr/0016. Everything additive.
-->

---

## The reframe

Loom 1.0 made AI workflows **durable, replayable, resumable**.

Loom 2.0 asks a bigger question:

> What is to AI applications what the **Linux kernel** is to programs?

**A kernel is:** durable · schedulable · resumable · observable · distributed · pluggable · **deterministic.**

Applications become *thin layers* over the kernel.

<!-- The 1.0 moat (the durable log) becomes the kernel's privileged core. Everything else is a module. -->

---

## The honest part: we critically evaluated the vision

A 12-phase vision is seductive. Not all of it survives contact with **determinism** and **DX**.

| Kept | Reshaped | Dropped |
|---|---|---|
| Execution as the universal primitive | Self-optimization → **opt-in, logged, auditable** | **Fibers** as a durable primitive (the log already owns pause/resume) |
| Reasoning routing + elevation | NL→app → **codegen you own**, not a runtime interpreter | **Speculative execution** of effects (expensive, non-deterministic) |
| Pluggable compute / memory | Marketplace, knowledge-graph → **AetherOS**, not the kernel | True **preemption** (wrong model for coarse LLM work) |

The rule that governed every call: **never regress P2 (deterministic replay) or the DX.**

---

## Two new principles (extend, never regress)

**P9 — Non-determinism is allowed, but only when logged.**
A runtime may route, elevate, learn, optimize — but every choice becomes a durable `DECISION_RECORDED` event. Replay stays a pure fold; a given run is reproducible forever; outcomes improve run-to-run.

**P10 — Minimal kernel; intelligence lives in an advisory plane.**
The core stays small. "Smart" is either *latency-only* (off-log) or *outcome-affecting* (logged) — never a hidden input to the fold. You never pay for a runtime you didn't opt into.

<!-- These two are THE unlock. They make the wild ideas safe by construction. -->

---

## The two spines

Everything in 2.0 hangs off two new core seams.

```
Spine A — Execution seam (M1)
  ctx.run(step)  ──generalizes to──▶  ctx.execute(task)
  task kinds: step · llm · agent · tool · ui · memory · human · plan
  Execution PCB (minimal)  +  ExecutionPolicy (sidecar, out-of-core)

Spine B — Decision seam (M2, P9)
  ctx.decide(id, optimizer)
     first run  ▶ run optimizer ▶ emit DECISION_RECORDED
     replay     ▶ serve recorded choice  (optimizer NOT called)
```

Spine B is the **twin** of how `ctx.run` short-circuits completed steps.

---

## M1 — The Execution seam

A **step** becomes just one *task kind*. The wire format is unchanged — old logs replay byte-identical.

```ts
// generalized primitive; ctx.run(step) is now a thin alias
const model = await ctx.execute(reasoningTask, { prompt });

// the PCB stays minimal (P10) — scheduling/compute/memory live in a sidecar
interface Execution { id; status; frames; sequence; parent?; children?; tags? }
interface ExecutionPolicy { priority?; resources?; computeTarget?; memoryScope?; retryPolicy? }
```

Additive, behavior-preserving: the simple path (`ctx.run`) stays a one-liner.

---

## M2 — The Decision seam (P9 made concrete)

```ts
// first run: optimizer consulted, choice recorded durably
// replay/resume: recorded choice returned, optimizer NEVER called
const model = await ctx.decide("route:reasoning", () =>
  reasoningRuntime.route(task, { confidence, budget }));
```

One primitive → the substrate for **reasoning routing (M3)**, **memory recall (M5)**, **self-optimization (M10)**, **runtime intelligence (M11)**.

> "Learned decisions, but logged." Outcomes get better; every run still replays bit-for-bit.

---

## M3 — Reasoning Runtime

The biggest value gap in 1.0: `LlmProvider.complete()` with no routing.

- **Cheap-first routing** → **confidence-based elevation** ladder (Gemma → Flash → Pro → Opus)
- **Confidence is a pluggable signal** — stop-reason / validator-pass / ensemble — *not a magic number*
- **Composable stages** (route · call · score · elevate · cache), not a god-object
- Every route/elevation **logged** via the decision seam → observable, replay-safe
- `intent` + `planner` re-based onto it; offline keyword fallback stays deterministic

---

## M5 — Memory tiers, with a determinism fix

Tiers: **working · episodic · semantic · procedural** — each with an eviction *or* summarization policy, plus **promotion** between tiers.

The critical part:

```ts
// outcome-affecting recall MUST be captured in the log, or replay diverges
const context = await memory.recall("semantic", scope, { decide: ctx.decide });
```

Logged recall → replay serves the **same** recalled set even if the store later changed. Non-deterministic memory can no longer break P2.

---

## M4 & M6 — Compute placement + Scheduler in the hot path

**M4 — Placement (where it runs):** `PlacementDispatcher` routes each execution to a named target (local / remote-HTTP / Cloud Run) by `ExecutionPolicy`. One target ⇒ passthrough; existing dispatch unchanged.

**M6 — Scheduler (admission control):** the ephemeral scheduler now sits in the effect path — **bounded concurrency + priority** across a runtime's effects. Zero-overhead by default (Infinity-concurrency fast path preserved). Optional off-log **warmer** (latency-only, no event).

---

## M3.5 — Scale-out storage (the real unblocker)

1.0's durable backend was single-node SQLite. Horizontal scale needs a network store.

`@loom/store-postgres` — same interfaces as SQLite:

- `PostgresEventStore` / `SnapshotStore` / `BranchRegistry` (JSONB payloads, server-side `copyPrefix`)
- **Cross-node live subscribe** via `LISTEN/NOTIFY` (each store ignores its own NOTIFYs)
- Drop-in: `defineConfig({ storage: { kind: "postgres", url } })`
- **Single-writer-per-execution (D3)** = the lock-free shard model

> Verified against a live Postgres 17 — conformance + cross-node subscribe + byte-identical replay vs SQLite.

---

## Does it earn "kernel"? — the six rings (K1–K6)

A framework becomes a kernel when it adds the enforcement rings a real kernel has:

| Ring | Mechanism |
|---|---|
| **K1 Syscall ABI** | `KERNEL_SYSCALLS` — versioned, conformance-pinned (`execute/run/decide/parallel/suspend/emit/stream/ui`) |
| **K2 Protection** | `EffectRuntime` denies ungranted effects (`GrantTable`, least-privilege); denials logged |
| **K3 Accounting** | `meteringMiddleware` — tokens/$/latency metered + budget **admission control** |
| **K4 Supervision** | `SupervisingDispatcher` — restart/backoff + **circuit breaker** |
| **K5 Event-schema ABI** | pinned on-disk event set + version; `deploy-sim` as the flow gate |

---

## The kernel readiness scorecard

| Kernel responsibility | Loom mechanism | ✓ |
|---|---|---|
| Process abstraction + lifecycle | `Execution` PCB · start/resume/fork/suspend | ✅ |
| Multiplexing & scheduling | single-writer sharding · scheduler in effect path | ✅ |
| Memory management | tiered memory + policies | ✅ |
| Determinism / reproducibility | event-sourced pure replay + decision seam | ✅✅ |
| **Syscall / ABI boundary** | K1 | ✅ |
| **Protection / authority** | K2 | ✅ |
| **Resource accounting & quotas** | K3 | ✅ |
| **Fault supervision** | K4 | ✅ |
| **On-disk ABI governance** | K5 | ✅ |

The part a kernel *cannot fake* — a privileged, unbypassable, deterministic core — was Loom's from day one.

---

## M7 & M8 — Capabilities and thinner agents

**M7 — Capability deepening:** `version` + `dependencies` (transitive `resolve()` with cycle detection) + **invoke authorization** (who may invoke a capability — distinct from the K2 effect ring).

**M8 — Agents re-based:** `AgentRunner` now composes the **Reasoning Runtime** — model routing/elevation moves *out* of the agent and into the runtime. Routes logged (`source: "agent"`). Bare-provider path unchanged.

> "Agents become lightweight; the runtimes do the heavy lifting."

---

## M9–M11 — Intelligence, done safely

The flashy phases — reshaped to **read-only / opt-in / logged / advisory**:

- **M9 Event intelligence** — pure analyzers over the log (execution · cost · reasoning · failure). *Lenses on the log, never a writer.*
- **M10 Self-optimization** — `rankModels` mines history; `rankedRouter` prefers proven models. Choices ride the decision seam → **auditable, override-able, never silently autonomous.**
- **M11 Runtime intelligence** — composes analytics + optimizers into an **advisory report** (rankings, hot failures, budget suggestion). Shapes future runs; never mutates the past.

---

## P11 — AI-native DX (NL → code you own)

Not a runtime NL interpreter. **Codegen.**

```
"Create a planner. Use Gemma first. Elevate to Gemini.
 Pause for approval. Deploy on Fargate. Generate UI."
        │  parseIntent (deterministic, offline)
        ▼
   AppSpec  (structured, JSON)
        │  generateApp (pure, template-based)
        ▼
   plain, static, inspectable TypeScript you own
   (flow$ / step$ / capability$ + defineConfig; ctx.suspend gate; ctx.ui)
```

The only "understanding" is the (swappable) parser producing a spec. Output is ordinary Loom code — **sugar, not a cage** (P4/P5).

---

## The layering

Loom is deliberately the **kernel** layer of a three-layer stack:

```
  AetherOS   ── platform: marketplaces · registries · cloud · governance
      │
   GenUI     ── application & interaction: blueprints · A2UI · multimodal surfaces
      │
   Loom 2.0  ── the execution kernel: execution · scheduling · reasoning ·
                memory · compute · projections · durability · determinism
```

Each evolves independently. Anything that's a marketplace or an interface is **not** the kernel (P10).

---

## Proof it holds together

- **Everything additive & opt-in** — existing apps compile and replay unchanged
- **94 / 94** test tasks green across every milestone
- **Benchmarks within committed baselines** throughout — the zero-overhead default is preserved
- **13 milestone commits**; full decision record in **ADR 0016**
- Verified against a **live Postgres 17** for the scale-out path

<!-- The discipline: every milestone re-ran the full suite + benches. No milestone shipped that could break determinism. -->

---

## Go deeper

| Want… | Read |
|---|---|
| The big picture | `docs/loom-2.0/00-overview.md` |
| The two spines + ABI | `docs/loom-2.0/01-execution-and-decision-seams.md` |
| Reasoning & memory | `docs/loom-2.0/02-reasoning-and-memory.md` |
| Compute · scheduling · storage | `docs/loom-2.0/03-compute-scheduling-storage.md` |
| The kernel rings (K1–K6) | `docs/loom-2.0/04-kernel-hardening.md` |
| Capabilities · agents · intelligence · DX | `docs/loom-2.0/05-capabilities-agents-intelligence-dx.md` |
| The on-disk event ABI | `docs/loom-2.0/10-event-schema-reference.md` |
| The decision record | `docs/adr/0016-…md` |

---

<!-- _paginate: false -->

## The North Star

Not "another agent framework."

# The first execution operating system for intelligent software.

**deterministic core · logged non-determinism · a real kernel you can build a platform on.**
