---
marp: true
theme: default
paginate: true
title: "Loom — what it is, what it's for, and how it differs"
style: |
  /* Marp does not error on overflow — it silently cuts the last element. These
     slides carry a table or a long list that the default 35px cannot hold, so
     they opt into a smaller body size rather than losing their last line. */
  section.dense { font-size: 25px; }
---

<!-- _paginate: false -->

# Loom

### What it is · what it's for · how it differs

**The durable execution kernel for intelligent software**

A positioning deck — for the "why this and not that?" conversation

<!--
Presenter: ~25 min. This deck answers three questions in order: what is it,
what problem does it exist to solve, and why not use <competitor>. If you only
have 10 minutes, present slides 3, 5, 8, 14, 20 and 27.

Companion decks: loom-deck.md (the flagship product overview),
leadership-deck.md (the business case), loom-vs-adk-deck.md (the deep dive on
one competitor).
-->

---

## Part I — What Loom is

---

## In one sentence

> **Loom is a durable execution kernel: a minimal, event-sourced core that runs long-lived,
> suspendable, replay-deterministic executions for intelligent software.**

Said less formally:

> Your AI workflow becomes a **process that unfolds over time**, not a request that returns once —
> and every meaningful thing it does becomes an immutable fact in a log.

So it can **pause for a human, resume on another machine, replay bit-for-bit, fork to explore alternatives, and be audited against its own history.**

---

## The one guarantee everything else serves

> A function can be interrupted at any point — waiting on a tool, a model, or a **human** — survive a
> process restart, and resume from exactly where it left off, **without the application code knowing
> the difference** between a fresh run and a replay.

That's it. That's the product.

Every package, every principle, every kernel ring in this repo exists to deliver that one sentence and refuse to compromise it.

<!--
Presenter: pause here. If the audience doesn't feel why that sentence is hard,
the rest of the deck won't land. Ask: "what happens to your agent today if the
pod is recycled at step 7 of 12, three days into an approval wait?"
-->

---

## What Loom is *not*

| Not a… | Because |
|---|---|
| **Workflow DSL** | A flow is an ordinary `async` function — `if`, `for`, `try`, your language. |
| **Agent library** | It doesn't compete with agent SDKs — it's the substrate they run *on*. |
| **Server you deploy** | A library. No cluster, no control plane, no sidecar. |
| **Managed service** | There is nothing to sign up for. Your log lives where you put it. |
| **Model or cloud** | Any provider, any storage, any compute — all behind interfaces. |

**Loom is the layer that makes execution durable. Everything else is your choice.**

---

## What you actually write

```ts
const runner: FlowRunner<In, Out> = async (ctx, input) => {
  ctx.ui.set("phase", "investigating");
  const found = await ctx.run(investigateStep, { target: input.target });

  // Durable checkpoint — persists, hands control back to the caller.
  const decision = await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.target });

  if (!decision.approved) return { applied: false };
  return ctx.run(applyStep, { target: input.target });
};
```

The process can die at *any* line. On resume, `investigateStep` is **served from the log, not re-run** — and the approval may arrive three days later, from any surface.

**No DSL. No state machine. No `extends`. Plain code with durable seams.**

---

## Part II — What it's for

---

<!-- _class: dense -->
## The problem Loom exists to solve

AI has moved inside flows that…

- **run for a long time** — seconds to days, often pausing for a human
- **call non-deterministic, expensive, fallible services** — models, tools, agents
- **must survive crashes, deploys, restarts** — without double-running work
- **must be explainable** — *why* did it do that? who approved it?
- **want alternatives explored** — what if we'd tried the other fix?

| Request/response framework | Heavyweight workflow engine |
| --- | --- |
| Easy to write | Durable |
| ❌ forgets on crash | ❌ restrictive DSL |
| ❌ can't pause for humans | ❌ external server, fights your UI |
| ❌ no replay | ❌ agent, memory & UI seams are yours to build |

---

## The thesis

## The durable event log is the moat.

If every meaningful thing that happens is appended to an **ordered, immutable log**, then durability, resumability, replay, branching, evaluation, and audit are all **different lenses on the same log**.

```
                     ┌──────────────────────────┐
   durability ◄──────┤                          ├──────► replay / debug
   resume     ◄──────┤    append-only event log ├──────► evals
   branching  ◄──────┤    state = fold(events)  ├──────► deploy-sim
   distribute ◄──────┤                          ├──────► audit
                     └──────────────────────────┘
```

**You don't add auditability later. It's the substrate.**

---

<!-- _class: dense -->
## The workloads Loom is built for

| Workload | Why Loom |
|---|---|
| **Human-in-the-loop approvals** | Suspension is a *normal outcome*. Days-long waits are the default. |
| **Long-horizon agents** | Multi-day work that survives deploys and never double-spends a model call. |
| **Regulated / audited AI** | The log *is* the audit trail — who decided what, when, on what evidence. |
| **Ops & remediation copilots** | Fork the live execution, simulate, promote the winner. |
| **Agentic UIs** | The same core runs in a browser tab; the UI is a fold of the same log. |

**Where it's overkill:** a single-turn completion, a stateless RAG lookup, a cron job that can just re-run.

---

## What the log buys you — six lenses, one mechanism

- **Durability** — the process can die anywhere; the log is the state.
- **Resume = migration** — workers are stateless, so any worker can continue any execution.
- **Effect memoization** — a crash after an expensive model call never pays for it twice.
- **Time-travel debugging** — fold to *any* sequence and inspect exact past state.
- **Branching** — fork at any point, simulate alternatives, promote the winner. Cheap, because a branch is just a shared log prefix.
- **Deploy safety** — replay real logs against new flow code and fail a resume-breaking change *before* it ships.

> Six features in most stacks. **One mechanism here.**

---

## Part III — How it differs

### The landscape, honestly

<!--
Presenter: the goal of Part III is credibility, not conquest. Every competitor
named here is good at what it does. Our claim is about LAYER and INTERSECTION,
not superiority on their home turf.
-->

---

## Three categories — and the seam has occupants

```
  ┌────────────────────────────┐          ┌────────────────────────────┐
  │  AGENT FRAMEWORKS          │          │  DURABLE ENGINES           │
  │  Google ADK 2.0 · CrewAI   │          │  Temporal · Dapr · Restate │
  │  LangGraph · OpenAI Agents │          │  Inngest · DBOS · Step Fns │
  └─────────────┬──────────────┘          └─────────────┬──────────────┘
                └────────────┐  both moved  ┌───────────┘
                             ▼   inward     ▼
        ┌────────────────────────────────────────────────┐
        │  DURABLE + AGENTIC                             │
        │  Diagrid Catalyst · ADK + Temporal · LOOM      │
        └────────────────────────────────────────────────┘
```

**In 2025 this seam was empty. It isn't any more — so the claim has to be sharper than "we're in the gap."**

---

<!-- _class: dense -->
## Category 1 — Agent frameworks

**Examples:** Google ADK 2.0 · LangGraph · CrewAI · OpenAI Agents SDK · Mastra

**What they're genuinely great at**

- Composing agents, tools, prompts and hand-offs with excellent ergonomics
- Rich built-in tooling — retrieval, code execution, multimodal, providers
- Fastest path from idea to a working agent; large communities
- Real persistence and human-interrupt support — not a "they have no state" claim

**Where the layer differs**

Several are now event-sourced — ADK 2.0 **returns completed tool results from event history**. The difference is **whose state machine it is**: ADK resumes from a `current_step` you maintain, and the caller must notice the crash. Loom's unit is the **execution** — a pure fold, re-driven by a supervisor.

> An agent SDK asks *how do I compose agents and tools?*
> A durable execution kernel asks *what happens when the process dies at step 7 of 12?*

---

<!-- _class: dense -->
## Category 2 — Durable execution engines

**Examples:** Temporal · Restate · Inngest · DBOS · AWS Step Functions

**What they're genuinely great at** — and Temporal especially

- Durable execution, deterministic replay, signals, timers — **the real thing**, for a decade
- Multi-language SDKs, mature ops tooling, large ecosystems, commercial support
- A million workflows a day with an ops team behind them: proven ground

**Where the layer differs**

- **Deployment shape** — most need a cluster or managed service. Loom is a **library**: the same core runs in a unit test, a Node server, or a **browser tab**.
- **Design center** — they record and replay effect results too; what Loom adds at that same seam is a decision's **provenance** — the policy and the propensity behind the choice (see D2).
- **Surface** — agents, tools, memory, policy and UI projection are first-class seams here.

---

## Category 3 — AI SDKs and orchestration libraries

**Examples:** Vercel AI SDK · LlamaIndex · Semantic Kernel · raw provider SDKs

**What they're genuinely great at**

- Streaming, structured output, tool-calling ergonomics, provider abstraction
- Minimal ceremony; excellent for the request/response shape they target

**Where the layer differs**

They are, by design, **stateless per call**. Durability, resumption, audit, and human-in-the-loop are explicitly out of scope — and correctly so.

**This is the most complementary category.** Loom treats a model call as an *effect*; what happens inside that effect can be any of these libraries.

---

## The positioning, in one line each

| | Asks | Loom's answer |
|---|---|---|
| **Agent frameworks** | How do I compose agents and tools? | Compose them however you like — inside durable steps. |
| **Durable engines** | How do I survive a crash at scale? | Same goal, but as an embeddable library that's AI-native by design. |
| **AI SDKs** | How do I call a model well? | Great — that's what goes inside an effect. |

> **"Which agent SDK?" is a smaller question than "what runtime is your agentic system built on?"**

---

## Six differentiators

### The things that are genuinely hard to assemble elsewhere

---

## D1 — One substrate: durable + agentic + UI

The same event log that makes execution durable also **drives the interface**.

- The flow emits events; a projection runtime folds them into view models; the UI renders from that fold and stays live.
- The durable core is **isomorphic** — no Node or DOM assumptions. The *same* flow runs in a test, a browser tab, a Node server with SQLite, or a serverless worker.
- Renderers are pluggable: React, Web Components, terminal — **same backend, swap the render layer.**

> A durable agentic app running entirely **in a browser tab**, with no server, is a shipped example
> in this repo — not a thought experiment.

---

## D2 — Decisions carry their propensity

**Recording what a model returned is table stakes** — ADK, Temporal, Dapr and Diagrid all do it. Loom records one thing more at the same seam:

> A `ctx.decide` logs the choice, **the policy that made it, and the probability it was drawn with.**

- That makes a decision evaluable **counterfactually, off real logs** — *"what would a different policy have scored?"* — without re-running anything (`@loom/learning`).
- **Propensity cannot be reconstructed later.** If it wasn't logged at the draw, it's gone.

**A bare decision log *looks* scored while being unevaluable. That's the difference.**

<!--
RETIRED, do not reuse: "classical engines quarantine non-determinism as a bug source,
Loom gives it a seam." Temporal and Dapr record activity results and replay them, so the
line does not survive contact with anyone who knows either. Propensity does.
-->

---

## D3 — Git-style branching of a live execution

Because state is `fold(events)`, a **branch is nearly free** — fork the log at any point.

```
   main   ──●──●──●──●─ suspended at approval gate
                     ├──○──○──○   branch A: roll forward
                     ├──○──○──○   branch B: roll back      ← simulate all three
                     └──○──○──○   branch C: dual-write        concurrently, on real state
                          ▲
                     promote the winner
```

**Fork → simulate → compare → promote.** Branch-only; no merge.

Shipped as two examples on two unrelated domains — incident remediation and schema migration — specifically to prove the seam is domain-agnostic.

---

## D4 — A library, not a platform

- **No server, no cluster, no control plane.** Add a dependency; you have a durable runtime.
- **No DSL.** Flows are `async` functions. You can always drop down a layer.
- **Composition over inheritance** — functions and small objects, never base classes you must `extends`.
- **Bring your own everything** — storage, compute, model, renderer are interfaces with adapters.

> **Adopt Loom without adopting a cloud.** Your durable state never leaves your trust boundary.

**Adoption cost is the differentiator here:** the honest comparison isn't feature-for-feature, it's *what you must stand up before you get the first guarantee.*

---

## D5 — Hardened kernel: security & compliance as primitives

Every side effect crosses **one seam** — which makes that seam the place to enforce everything:

- **Capabilities** — least privilege; a denial is a logged fact and the effect never runs.
- **Quotas & metering** — tokens, cost, time metered per effect and folded into state.
- **Egress isolation · fencing · tenancy** — a zombie can't double-write; tenants isolated.
- **Data protection** — classify once and encryption, redaction and egress scrubbing derive; **crypto-shredding** satisfies erasure by destroying a key.

**Durable logging *without* the PII liability** — the objection that stops most event-sourcing proposals.

**Every ring is opt-in and byte-identical when unwired.** You never pay for what you don't turn on.

---

## D6 — A specified kernel, not a vibe

Rare at this layer, and the reason the guarantees are quotable:

- A **normative specification** — MUST/SHOULD for execution, replay, compatibility.
- A **pinned syscall ABI and event schema** — CI fails on undocumented drift.
- **Conformance kits** — a third-party store *runs a suite* to prove it conforms.
- **Executable fitness functions** — replay-unchanged, ABI-pinned, gated per PR.
- **Evidence-derived maturity badges** — a badge fails CI if it lacks its evidence.

> Architecture that isn't executable is architecture that has already drifted.

---

<!-- _class: dense -->
## Side-by-side — the durability axes

Compared on *axes*, not feature checkboxes, because products move faster than slides.

| Axis | Agent frameworks | Durable engines | **Loom** |
|---|---|---|---|
| **Unit of durability** | session + your state machine | workflow execution | **execution** |
| **The record** | app DB or vendor service | engine cluster | **your event log** |
| **Replay model** | event history + memoized tools | deterministic replay | **fold + memoized effects** |
| **Crash re-drive** | caller re-invokes | ✅ the engine | **✅ supervisor + fencing** |
| **Deployment** | library + your infra | cluster or SaaS | **library; runs in-browser** |

*(AI SDKs are stateless per call — they sit inside a step, not on this axis.)*

---

<!-- _class: dense -->
## Side-by-side — the axes nobody else covers

| Axis | Agent frameworks | Durable engines | **Loom** |
|---|---|---|---|
| **Decision provenance** | the outcome | the outcome | **outcome + policy + propensity** |
| **Branch a live run** | ➖ | ➖ | **✅ fork / simulate / promote** |
| **UI from the same log** | ➖ | ➖ | **✅ projections** |
| **Capability / tenancy ring** | platform's job | partial | **✅ in-kernel, opt-in** |
| **GDPR erasure primitives** | DIY | DIY | **✅ crypto-shredding** |

> The first table is where the field caught up. **This one is the argument.**

---

<!-- _class: dense -->
## Where the competition wins — honestly

**Do not present the previous slide without this one.**

- **Temporal & friends** — a decade of hardening, multi-language SDKs, mature ops tooling, proven at enormous scale. Loom is younger; if you need that *today*, take it.
- **Agent frameworks** — larger ecosystems, deeper tooling, a faster path to a first demo. Want an agent shipped this week? They'll beat us.
- **Framework + engine combinations** — **ADK + Temporal** (official) and **Diagrid Catalyst** deliver durable agentic execution today. Already on Temporal or Dapr? That's rational.
- **Managed platforms (ADK/Vertex, hosted engines)** — nothing to operate, which is a real advantage.
- **AI SDKs** — for a single-turn call, they are simply the right tool. Loom would be ceremony.

> **Our advantages compound with longevity, regulation, cost-per-step and portability.** For a short-horizon, unregulated workload we are not the best answer — and saying so is what makes the rest credible.

---

## Complementary far more often than competing

Loom is a **substrate**, not a rival agent library:

- Wrap an external agent (ADK, LangGraph, CrewAI) as a **durable effect** over A2A — it gains durability, replay, capability control, and audit for free.
- Expose your Loom flows *to* those ecosystems — every agent can be advertised as a discoverable card.
- Call any tool over **MCP**; call any model through the provider seam.
- Use an AI SDK **inside** a step. Loom doesn't care what happens in there — only that it's recorded.

**The question isn't "Loom *or* X." It's usually "X, running on Loom."**

---

<!-- _class: dense -->
## Choosing — a decision guide

**Choose Loom when at least two of these are true:**

- Work runs **longer than a request** and pauses for humans
- A step is **expensive enough** that re-running it on a crash hurts
- You must answer **"why did it do that?"** to an auditor or a customer
- You need to **explore alternatives** on real in-flight state
- Durable state **must not leave your trust boundary** — or you want the **same runtime** in a test, a browser and prod

**Choose something else when:**

- It's single-turn, stateless, or cheaply re-runnable
- You need a managed runtime with zero ops today
- You need proven multi-language, mega-scale throughput right now

---

## Bottom line

> **Agent frameworks help you build an agent. Durable engines help a workflow survive.
> Both now reach into the middle — so the claim is what Loom adds there, not that the middle is empty.**

- **What it is** — a durable execution kernel; the log is the source of truth
- **What it's for** — long-running, human-in-the-loop, auditable, expensive-step AI work
- **How it differs** — one substrate for durability + agents + UI · decisions that carry their *propensity* · branchable live executions · a library not a platform · security and compliance as primitives · a specified, conformance-tested kernel

**You don't add durability, auditability, or reproducibility later. They're the substrate.**

---

<!-- _class: dense -->
## A note on fairness

- Every product named here is **good at what it does**. The comparisons are about **architectural layer and design center**, not quality.
- **Competitive facts re-verified 2026-09-13.** ADK 2.0 is Python/TS/Go GA, event-sourced, memoizes completed tool results and has first-class durable human-in-the-loop pauses; **Diagrid Catalyst** occupies the durable+agentic seam. This landscape moves fast — **verify before quoting a slide.**
- **Two arguments were retired and must not come back:** that an agent framework's durability is "a snapshot you reload", and that "classical engines quarantine non-determinism while we record it".
- **Loom's claims are grounded in shipped code, ADRs and the normative spec in this repo.**
- If a slide can't be traced to one of those, cut it. **An overclaim costs more than it wins.**

---

## Appendix — where to go next

| Audience / question | Deck or doc |
|---|---|
| The full product overview | [`loom-deck.md`](./loom-deck.md) |
| The business case, value, adoption path | [`leadership-deck.md`](./leadership-deck.md) |
| One competitor in depth | [`loom-vs-adk-deck.md`](./loom-vs-adk-deck.md) |
| How the machinery works | [`architecture-deck.md`](./architecture-deck.md) |
| The kernel layer & principles | [`loom-2.0-deck.md`](./loom-2.0-deck.md) |
| What we guarantee, and how we prove it | [`../spec/loom-kernel-specification.md`](../spec/loom-kernel-specification.md) |
| Live demos | [`demo-script.md`](./demo-script.md) |

<!--
Presenter: close by offering the demo. The branching demo (Incident War Room)
is the single most differentiating thing to show live — nothing else in the
landscape does fork/simulate/promote on a live execution. If challenged: Dapr
has conditional branching, which is ordinary if-statements replayed
deterministically — not forking the log to explore alternatives on real state.
That distinction was checked; it is the one to give.
-->
