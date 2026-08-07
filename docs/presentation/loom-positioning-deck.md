---
marp: true
theme: default
paginate: true
title: "Loom — what it is, what it's for, and how it differs"
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

So it can **pause for a human, resume on another machine, replay bit-for-bit, fork to explore
alternatives, and be audited against its own history.**

---

## The one guarantee everything else serves

> A function can be interrupted at any point — waiting on a tool, a model, or a **human** — survive a
> process restart, and resume from exactly where it left off, **without the application code knowing
> the difference** between a fresh run and a replay.

That's it. That's the product.

Every package, every principle, every kernel ring in this repo exists to deliver that one sentence
and refuse to compromise it.

<!--
Presenter: pause here. If the audience doesn't feel why that sentence is hard,
the rest of the deck won't land. Ask: "what happens to your agent today if the
pod is recycled at step 7 of 12, three days into an approval wait?"
-->

---

## What Loom is *not*

| Not a… | Because |
|---|---|
| **Workflow DSL** | A flow is an ordinary `async` function. `if`, `for`, `try` — your language, not a YAML graph. |
| **Agent library** | It doesn't compete with agent authoring SDKs — it's the substrate they run *on*. |
| **Server you deploy** | It's a library. No cluster, no control plane, no sidecar required. |
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

The process can die at *any* line. On resume, `investigateStep` is **served from the log, not
re-run** — and the approval may arrive three days later, from any surface.

**No DSL. No state machine. No `extends`. Plain code with durable seams.**

---

## Part II — What it's for

---

## The problem Loom exists to solve

AI has moved inside flows that…

- **run for a long time** — seconds to days, often pausing for a human
- **call non-deterministic, expensive, fallible services** — models, tools, other agents
- **must survive crashes, deploys, restarts** — without losing or double-running work
- **must be explainable** — *why* did the agent do that? who approved it?
- **want alternatives explored** — what if we'd tried the other fix?

The industry's usual answer forces a bad trade:

| Request/response framework | Heavyweight workflow engine |
| --- | --- |
| Easy to write | Durable |
| ❌ forgets on crash | ❌ restrictive DSL |
| ❌ can't pause for humans | ❌ external server, fights your UI |
| ❌ no replay | ❌ not built for non-determinism |

---

## The thesis

## The durable event log is the moat.

If every meaningful thing that happens is appended to an **ordered, immutable log**, then durability,
resumability, replay, branching, evaluation, and audit are all **different lenses on the same log**.

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

## The workloads Loom is built for

| Workload | Why Loom |
|---|---|
| **Human-in-the-loop approvals** | Suspension is a *normal outcome*, not a bolt-on. Days-long waits are the default case. |
| **Long-horizon agents** | Multi-step, multi-day work that must survive deploys and never double-spend a model call. |
| **Regulated / audited AI** | The log *is* the audit trail. Who decided what, when, on what evidence — by construction. |
| **Ops & remediation copilots** | Fork the live execution, simulate alternatives, promote the winner. |
| **Agentic UIs** | The same durable core runs in a browser tab; the UI is a fold of the same log. |

**Where it's overkill:** a single-turn chat completion, a stateless RAG lookup, a cron job that can
just re-run. Use the simple thing. Loom's value compounds with **longevity, cost-per-step,
regulation, and blast radius**.

---

## What the log buys you — six lenses, one mechanism

- **Durability** — the process can die anywhere; the log is the state.
- **Resume = migration** — workers are stateless, so any worker can continue any execution.
- **Effect memoization** — a crash after an expensive model call never pays for it twice.
- **Time-travel debugging** — fold to *any* sequence and inspect exact past state.
- **Branching** — fork at any point, simulate alternatives, promote the winner. Cheap, because a
  branch is just a shared log prefix.
- **Deploy safety** — replay real logs against new flow code and fail a resume-breaking change
  *before* it ships.

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

## The key insight: three categories, and Loom is in the seam

```
   ┌─────────────────────────────┐        ┌─────────────────────────────┐
   │   AGENT FRAMEWORKS          │        │  DURABLE EXECUTION ENGINES  │
   │   LangGraph · CrewAI        │        │  Temporal · Restate         │
   │   AutoGen · Google ADK      │        │  Inngest · DBOS · Step Fns  │
   │   OpenAI Agents SDK         │        │                             │
   │                             │        │                             │
   │   great at: composing       │        │   great at: surviving       │
   │   agents, tools, prompts    │        │   crashes at scale          │
   └──────────────┬──────────────┘        └──────────────┬──────────────┘
                  │                                      │
                  └───────────────┐      ┌───────────────┘
                                  ▼      ▼
                          ┌───────────────────────┐
                          │        LOOM           │
                          │  durable execution    │
                          │  that is AI-native    │
                          │  and embeddable       │
                          └───────────────────────┘
```

**Most tools are excellent in one box. Loom's bet is that the interesting problems live in the seam.**

---

## Category 1 — Agent frameworks

**Examples:** LangGraph · CrewAI · AutoGen · Google ADK · OpenAI Agents SDK · Mastra

**What they're genuinely great at**

- Composing agents, tools, prompts, and hand-offs with excellent ergonomics
- Rich built-in tooling — retrieval, code execution, multimodal, provider integrations
- Fastest path from idea to a working agent; large, fast-moving communities
- Several offer real persistence and human-interrupt support — this is not a "they have no state" claim

**Where the layer differs**

Their unit of durability is a **session or graph checkpoint** — a snapshot of state you reload. Loom's
is the **execution**, reconstructed by a pure fold with per-effect memoization.

> An agent SDK asks *how do I compose agents and tools?*
> A durable execution kernel asks *what happens when the process dies at step 7 of 12?*

---

## Category 2 — Durable execution engines

**Examples:** Temporal · Restate · Inngest · DBOS · AWS Step Functions

**What they're genuinely great at** — and Temporal especially

- Durable execution, deterministic replay, signals, timers — **the real thing**, battle-tested at
  serious scale for a decade
- Multi-language SDKs, mature operational tooling, large ecosystems, commercial support
- If you need to run a million workflows a day with an ops team behind them, this is proven ground

**Where the layer differs**

- **Deployment shape** — most require an external cluster or managed service. Loom is a **library**;
  the same core runs in a unit test, a Node server, or a **browser tab**.
- **Design center** — they were designed for deterministic business transactions and treat
  non-determinism as a hazard to be quarantined. Loom is designed *for* non-determinism (see D2).
- **Surface** — agents, tools, memory, policy, and UI projection are first-class seams here, not
  things you build above the engine.

---

## Category 3 — AI SDKs and orchestration libraries

**Examples:** Vercel AI SDK · LlamaIndex · Semantic Kernel · raw provider SDKs

**What they're genuinely great at**

- Streaming, structured output, tool-calling ergonomics, provider abstraction
- Minimal ceremony; excellent for the request/response shape they target

**Where the layer differs**

They are, by design, **stateless per call**. Durability, resumption, audit, and human-in-the-loop are
explicitly out of scope — and correctly so.

**This is the most complementary category.** Loom treats a model call as an *effect*; what happens
inside that effect can be any of these libraries.

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

- The flow emits events; a projection runtime folds them into view models; the UI renders from that
  fold and stays live.
- The durable core is **isomorphic** — no Node or DOM assumptions. The *same* flow runs in a test, a
  browser tab, a Node server with SQLite, or a serverless worker.
- Renderers are pluggable: React, Web Components, terminal — **same backend, swap the render layer.**

> A durable agentic app running entirely **in a browser tab**, with no server, is a shipped example
> in this repo — not a thought experiment.

---

## D2 — Built *for* non-determinism, not around it

The design center that separates Loom from classical workflow engines:

> **Non-determinism is allowed — but only when logged.** A model routing choice, a sample, an
> elevation to a stronger model: each is recorded as a durable decision and **served from the log on
> replay, never re-computed.**

The result is a property most engines can't offer:

**A given execution replays bit-for-bit forever — while outcomes improve run-to-run.**

Classical engines quarantine non-determinism as a bug source. Loom gives it a **seam**, because for
AI workloads it is the *point*, not an accident.

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

Shipped as two examples on two unrelated domains — incident remediation and schema migration —
specifically to prove the seam is domain-agnostic.

---

## D4 — A library, not a platform

- **No server, no cluster, no control plane.** Add a dependency; you have a durable runtime.
- **No DSL.** Flows are `async` functions. You can always drop down a layer.
- **Composition over inheritance** — functions and small objects, never base classes you must
  `extends`.
- **Bring your own everything** — storage, compute, model, renderer are interfaces with adapters.

> **Adopt Loom without adopting a cloud.** Your durable state never leaves your trust boundary.

**Adoption cost is the differentiator here:** the honest comparison isn't feature-for-feature, it's
*what you must stand up before you get the first guarantee.*

---

## D5 — Hardened kernel: security & compliance as primitives

Every side effect crosses **one seam** — which makes that seam the place to enforce everything:

- **Capabilities** — least privilege; a step may only use effects it was granted. A denial is a
  logged fact and the effect never runs.
- **Quotas & metering** — tokens, cost, time metered per effect and folded into state.
- **Egress isolation · fencing · tenancy** — a zombie predecessor can't double-write; tenants are
  isolated by construction.
- **Data protection** — classify once (`secret`/`sensitive`/`internal`), and encryption, redaction,
  and egress scrubbing derive automatically. **Crypto-shredding** satisfies erasure by destroying a
  key; subject export/erasure are built in.

**Durable logging *without* the PII liability** — the objection that stops most event-sourcing
proposals in regulated shops.

**Every ring is opt-in and byte-identical when unwired.** You never pay for what you don't turn on.

---

## D6 — A specified kernel, not a vibe

Rare at this layer, and the reason the guarantees are quotable:

- A **normative specification** — MUST/SHOULD language for execution, replay, event, suspension,
  placement, and compatibility semantics.
- A **pinned syscall ABI** and a **pinned event schema** — the log is a versioned on-disk contract.
  Adding is minor; removing is a major break, and CI fails on undocumented drift.
- **Conformance kits** — a third-party storage or dispatch implementation *runs a suite* to prove it
  honours the contract.
- **Executable fitness functions** — replay-unchanged, ABI-pinned, schema-compatible,
  zero-overhead-when-disabled, all gated on every PR.
- **Evidence-derived maturity badges** — a capability's badge fails CI if it claims evidence it
  doesn't have.

> Architecture that isn't executable is architecture that has already drifted.

---

## Side-by-side — by design axis

Compared on *axes*, not feature checkboxes, because products move faster than slides.

| Axis | Agent frameworks | Durable engines | AI SDKs | **Loom** |
|---|---|---|---|---|
| **Unit of durability** | session / graph checkpoint | workflow execution | none | **execution** |
| **The record** | app DB or vendor service | engine cluster / service | — | **your event log** |
| **Replay model** | reload & re-drive | deterministic replay | — | **pure fold + memoized effects** |
| **Deployment** | library + your infra | cluster or SaaS | library | **library; runs in-browser** |
| **Authoring** | graph / agent API | plain code (SDK) | plain code | **plain `async` code** |
| **Non-determinism** | inherent, unrecorded | quarantined | inherent | **first-class, recorded** |
| **Branch a live run** | ➖ | ➖ | — | **✅ fork/simulate/promote** |
| **UI from the same log** | ➖ | ➖ | streaming only | **✅ projections** |
| **Capability / tenancy ring** | platform's job | partial | — | **✅ in-kernel, opt-in** |
| **GDPR erasure primitives** | DIY | DIY | — | **✅ crypto-shredding** |

---

## Where the competition wins — honestly

**Do not present the previous slide without this one.**

- **Temporal & friends** — a decade of production hardening, multi-language SDKs, mature ops tooling,
  proven at enormous scale, commercial support. Loom is younger. If you need battle-tested throughput
  with an SRE org behind it *today*, that is a real and rational reason to choose them.
- **Agent frameworks** — larger ecosystems, deeper built-in tooling, far more community examples, and
  a faster path to a first demo. If you want an agent shipped this week, they'll beat us.
- **Managed platforms (ADK/Vertex, hosted engines)** — nothing to operate. If you don't want to own
  storage and compute, that is a genuine advantage.
- **AI SDKs** — for a single-turn call, they are simply the right tool. Loom would be ceremony.

> **Loom's advantages compound with longevity, regulation, cost-per-step, and portability.**
> For a short-horizon, single-turn, unregulated workload, we are not the best answer — and saying so
> is what makes the rest of the deck credible.

---

## Complementary far more often than competing

Loom is a **substrate**, not a rival agent library:

- Wrap an external agent (ADK, LangGraph, CrewAI) as a **durable effect** over A2A — it gains
  durability, replay, capability control, and audit for free.
- Expose your Loom flows *to* those ecosystems — every agent can be advertised as a discoverable card.
- Call any tool over **MCP**; call any model through the provider seam.
- Use an AI SDK **inside** a step. Loom doesn't care what happens in there — only that it's recorded.

**The question isn't "Loom *or* X." It's usually "X, running on Loom."**

---

## Choosing — a decision guide

**Choose Loom when at least two of these are true:**

- Work runs **longer than a request** and pauses for humans
- A step is **expensive enough** that re-running it on a crash actually hurts
- You need to answer **"why did it do that?"** to an auditor, a regulator, or a customer
- You need to **explore alternatives** on real in-flight state
- Durable state **must not leave your trust boundary**
- You want the **same runtime** in a test, a browser, and production

**Choose something else when:**

- It's single-turn, stateless, or cheaply re-runnable
- You need a managed runtime with zero ops today
- You need proven multi-language, mega-scale throughput right now

---

## Bottom line

> **Agent frameworks help you build an agent. Durable engines help a workflow survive.
> Loom is where those meet — and it's built for the fact that the workload is non-deterministic.**

- **What it is** — a durable execution kernel; the log is the source of truth
- **What it's for** — long-running, human-in-the-loop, auditable, expensive-step AI work
- **How it differs** — one substrate for durability + agents + UI · non-determinism as a *seam* ·
  branchable live executions · a library not a platform · security and compliance as primitives ·
  a specified, conformance-tested kernel

**You don't add durability, auditability, or reproducibility later. They're the substrate.**

---

## A note on fairness

- Every product named here is **good at what it does**, and several overlap with Loom in real ways.
  The comparisons above are about **architectural layer and design center**, not quality.
- This landscape moves **very fast**. Category slides describe general design shape as of this
  writing — **verify a competitor's current capabilities before quoting a slide at them.** Several
  have shipped persistence and human-in-the-loop features that a stale deck would misrepresent.
- **Loom's own claims are grounded in shipped code, ADRs, and the normative spec in this repo** —
  `docs/spec/loom-kernel-specification.md`, `docs/spec/fitness-functions.md`, `docs/architecture.md`.
- If a slide can't be traced to one of those, cut it. **An overclaim costs more than it wins.**

---

## Appendix — where to go next

| Audience / question | Deck or doc |
|---|---|
| The full product overview | [`loom-deck.md`](./loom-deck.md) |
| The business case, value, adoption path | [`leadership-deck.md`](./leadership-deck.md) |
| One competitor in depth | [`loom-vs-adk-deck.md`](./loom-vs-adk-deck.md) |
| How the machinery works | [`architecture-deck.md`](./architecture-deck.md) · [`../architecture.md`](../architecture.md) |
| The kernel layer & principles | [`loom-2.0-deck.md`](./loom-2.0-deck.md) · [`../loom-2.0/00-overview.md`](../loom-2.0/00-overview.md) |
| What we guarantee, normatively | [`../spec/loom-kernel-specification.md`](../spec/loom-kernel-specification.md) |
| How we prove it, continuously | [`../spec/fitness-functions.md`](../spec/fitness-functions.md) |
| Building this in another language | [`porting-loom-deck.md`](./porting-loom-deck.md) |
| Live demos | [`demo-script.md`](./demo-script.md) |

<!--
Presenter: close by offering the demo. The branching demo (Incident War Room)
is the single most differentiating thing to show live — nothing else in the
landscape does fork/simulate/promote on a live execution.
-->
