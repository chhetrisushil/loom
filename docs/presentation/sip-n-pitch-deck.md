---
marp: true
theme: default
paginate: true
title: "Loom — Sip n Pitch (30 min, engineers)"
---

<!-- _paginate: false -->

# Loom

### Your agent just died at step 7 of 12.
### Three days into an approval wait.

**What happens next?**

*Sip n Pitch · 30 minutes · ~13 min talk, ~15 min live demo, Q&A*

<!--
TIMING PLAN (30 min hard stop) — 30 slides
  0:00  Act I    The problem            3 min   → "The shape of the work changed"
  3:00  Act II   The idea               4 min   → "Loom, in one sentence"
  7:00  Act III  What it buys you       3 min   → "Six features. One mechanism."
 10:00  Act IV   Competitive            5 min   → "Three categories"   ← what they came for
 15:00  Act V    LIVE DEMO             13 min   → loom-demo/DEMO_SCRIPT.md
 28:00  Close + Q&A                     2 min   → "Bottom line"

Watch the clock at "Three categories" — if it's later than 10:30, cut in this
order: (1) "Git-style branching", (2) "Side-by-side, by design axis",
(3) "Two rules that make it work".

NEVER cut "Where the competition wins — honestly" or the demo's crash/resume
act. Those two are what make the rest believable.

Audience is engineers. Show code early, don't over-sell, and let the
crash/resume demo do the closing argument for you.
-->

---

## Act I — The problem

---

## The shape of the work changed

AI moved inside flows that:

- **run for a long time** — seconds to days, often pausing for a human
- **call expensive, fallible, non-deterministic things** — models, tools, other agents
- **must survive crashes, deploys, restarts** — without losing or double-running work
- **must be explainable** — *why* did the agent do that? who approved it?

A single model call is a request. **An agent is a process.**

<!--
Presenter: don't rush this. If the room doesn't feel the difference between
"a request" and "a process", nothing else lands. Ask for hands: "who has an
agent in production that waits on a human?"
-->

---

## And the usual answers force a bad trade

| Request/response agent framework | Heavyweight workflow engine |
| --- | --- |
| ✅ Easy to write | ✅ Durable |
| ❌ forgets on crash | ❌ restrictive DSL / boilerplate |
| ❌ can't pause for humans | ❌ external server to operate |
| ❌ no replay | ❌ built to *forbid* non-determinism |

> The interesting problems live in the seam between these two columns.

---

## Act II — The idea

---

## Loom, in one sentence

> **A durable execution kernel: a minimal, event-sourced core that runs long-lived,
> suspendable, replay-deterministic executions.**

Less formally:

> Your AI workflow becomes a **process that unfolds over time**, not a request that
> returns once — and every meaningful thing it does becomes an immutable fact in a log.

So it can **pause for a human, resume on another machine, replay bit-for-bit, fork to explore alternatives, and be audited against its own history.**

---

## The one guarantee everything serves

> A function can be interrupted at any point — waiting on a tool, a model, or a **human** —
> survive a process restart, and resume from exactly where it left off, **without the
> application code knowing the difference** between a fresh run and a replay.

That's the product. Every package and every design rule exists to deliver that one sentence and refuse to compromise it.

<!--
Presenter: pause. This is the thesis statement of the whole talk, and the demo
in Act V is literally this sentence executed on stage.
-->

---

## What you actually write

```ts
const runner: FlowRunner<In, Out> = async (ctx, input) => {
  const stats   = await ctx.run(inspectStep, input);   // durable step
  const verdict = await ctx.run(assessStep, stats);    // a real model call

  if (verdict.risk === "low") return ctx.run(applyStep, input);

  // Durable checkpoint. Persists, hands control back, may wait days.
  const decision = await ctx.suspend<ApprovalDecision>({
    on: "ApprovalGranted", correlationKey: input.table,
  });

  if (!decision.approved) return { applied: false, risk: verdict.risk };
  return ctx.run(applyStep, input);
};
```

**No DSL. No state machine. No queue.** The process can die at *any* line — on resume, `inspectStep` and `assessStep` are **served from the log, not re-run**.

---

## The thesis

## The durable event log is the moat.

If every meaningful thing that happens is appended to an **ordered, immutable log**, then durability, resumability, replay, branching, evaluation, and audit are all **different lenses on the same log**.

```
                     ┌──────────────────────────┐
   durability ◄──────┤                          ├──────► replay / time-travel
   resume     ◄──────┤    append-only event log ├──────► evals
   branching  ◄──────┤    state = fold(events)  ├──────► deploy-safety check
   distribute ◄──────┤                          ├──────► audit
                     └──────────────────────────┘
```

**You don't add auditability later. It's the substrate.**

---

## Two rules that make it work

**1. State is a pure fold.** `state = fold(events)`. Never a snapshot you mutate. That's what makes replay exact and branching nearly free.

**2. Non-determinism is allowed — but only when logged.** A model call, a routing choice, a sample: each is recorded as a durable fact and **served from the log on replay, never re-computed.**

> The result is a property most engines can't offer:
> **a given execution replays bit-for-bit forever — while outcomes improve run to run.**

<!--
Presenter: rule 2 is the single most important architectural claim in the deck.
It is what "What the integration had to do is the whole argument" turns on.
Plant it here, harvest it there.
-->

---

## Act III — What it buys you

---

## Six features. One mechanism.

| You get | Because the log is the state |
|---|---|
| **Durability** | The process can die anywhere; the log *is* the state. |
| **Resume = migration** | Workers are stateless — any worker continues any execution. |
| **Effect memoization** | A crash after an expensive call never pays for it twice. |
| **Time-travel debugging** | Fold to *any* sequence; inspect exact past state. |
| **Branching** | Fork, simulate alternatives, promote the winner. |
| **Deploy safety** | Fail a resume-breaking change *before* it ships. |

> Six line items in most stacks. **One mechanism here.**

---

## Git-style branching of a live execution

Because state is `fold(events)`, a branch is a **shared log prefix** — nearly free.

```
   main   ──●──●──●──●─ suspended at the approval gate
                     ├──○──○──○   branch A: roll forward
                     ├──○──○──○   branch B: roll back      ← simulate all three
                     └──○──○──○   branch C: dual-write        concurrently, on real state
                          ▲
                     promote the winner
```

**Fork → simulate → compare → promote.** Branch-only; no merge.

Shipped on two unrelated domains — incident remediation and schema migration — specifically to prove the seam isn't domain-shaped.

---

## Where Loom is the wrong tool

**Be honest about this before anyone asks.**

- A single-turn chat completion
- A stateless RAG lookup
- A cron job that can just re-run safely

Use the simple thing. **Loom's value compounds with longevity, cost-per-step, regulation, and blast radius** — not with cleverness.

> If your agent finishes in 900ms and re-running it is free, you do not need a kernel.

---

## Act IV — The competitive question

### "Why not just use X?"

<!--
Presenter: this is the section engineers actually came for. The goal is
CREDIBILITY, not conquest. Every product named here is good. Our claim is about
LAYER and DESIGN CENTER, never quality.

If someone in the room works on ADK or Temporal, lean harder into the credit
paragraph on "Fine — I'll just use ADK + Temporal". Never bluff a competitor's
feature set — see "A note on fairness".
-->

---

## Three categories — and Loom sits in the seam

```
   ┌─────────────────────────────┐        ┌─────────────────────────────┐
   │   AGENT FRAMEWORKS          │        │  DURABLE EXECUTION ENGINES  │
   │   Google ADK · LangGraph    │        │  Temporal · Restate         │
   │   CrewAI · OpenAI Agents    │        │  Inngest · DBOS · Step Fns  │
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

---

## vs. Google ADK — a different layer

**ADK is an excellent agent-authoring SDK** — deep Gemini/Vertex integration, workflow agents, built-in tools, live multimodal, a managed runtime. Want an agent shipped this week on GCP? It wins.

| | **Google ADK** | **Loom** |
|---|---|---|
| What it is | SDK to *author* agents | a *durable execution runtime* |
| Unit of durability | session snapshot you reload | **the execution** |
| Runtime of record | the managed runtime | **your event log, anywhere** |
| Resume semantics | reload a session, re-drive | **fold + memoized effects** |

> An agent SDK asks *how do I compose agents and tools?*
> A kernel asks *what happens when the process dies at step 7 of 12?*

---

## vs. Temporal — the same goal, a different shape

**Temporal is the real thing** — a decade of hardening, deterministic replay, signals, timers, multi-language SDKs, enormous scale. On durability they have nothing to prove.

| | **Temporal** | **Loom** |
|---|---|---|
| Deployment | a **server/cluster** you run or buy | **a library** |
| Runs in a browser tab | ➖ | ✅ same core |
| Design center | deterministic transactions | **non-deterministic AI work** |
| Non-determinism | **quarantined** into Activities | **recorded as a fact** |

> Not "Temporal is wrong." **Temporal is a platform; Loom is a dependency.**

---

## "Fine — I'll just use ADK **+** Temporal."

### This is the strongest answer in the market, and it's real.

Temporal shipped an official ADK integration. It is genuinely well-designed: it pushes **every LLM call and tool invocation into its own Activity** — durable execution *inside* the agentic loop, not a single activity wrapped around the whole agent.

- `TemporalModel` — routes model calls through Activities
- `activity_tool` — wraps tools with retries + heartbeating
- `GoogleAdkPlugin` — worker setup, serialization, deterministic time/UUID

**If you are a Python shop on GCP that already runs Temporal, this is a rational choice and you should take it seriously.** So should we.

<!--
Presenter: say this slide with a straight face and real respect. If you sneer
here you lose every senior engineer in the room. The NEXT slide is where the
argument actually happens — and it's an architectural argument, not a dunk.
-->

---

## What the integration had to do is the whole argument

To run ADK inside a Temporal workflow, the integration **had to patch ADK's clock and UUID generator** — new `google.adk.platform.time` / `google.adk.platform.uuid` seams, so Temporal could substitute `workflow.now()` and `workflow.uuid4()` on replay.

> That's not a criticism. That's a **design center** showing through.
> A classical engine must make the agent deterministic, because non-determinism is a
> hazard it quarantines.

**Loom never had to do that** — because it doesn't require the agent to be deterministic. It records what the non-deterministic thing *returned*, and serves that from the log.

> **They quarantine non-determinism. We record it.**
> Everything else on the next two slides follows from that one choice.

<!--
Presenter: this is the intellectual core of the talk. If you land one slide in
the competitive section, land this one. The fact is checkable — the ADK PR that
added google.adk.platform.time / .uuid is public. Offer that if challenged.

Do NOT claim this makes Temporal wrong. For deterministic business transactions
quarantining is the correct design. The claim is narrower and defensible: for an
AI workload the non-determinism IS the payload, so a seam beats a quarantine.
-->

---

## The ledger, part 1 — what it costs to get there

| Axis | **ADK + Temporal** | **Loom** |
|---|---|---|
| **Maturity of the seam** | **experimental**; breaking changes flagged | v1 kernel, pinned ABI + event schema |
| **Language** | **Python only** (others "likely to follow") | TypeScript |
| **Infra for guarantee #1** | **a running Temporal server** | **a dependency** |
| **Dev/prod parity** | `adk web` locally ⇒ *"you won't get the benefits of durable execution"* | **same runtime** in a test, a browser, prod |
| **Roadmap risk** | ADK **and** Temporal must both keep the seam alive | one kernel |

<!--
Presenter: the dev/prod parity row is the one engineers react to. That quote is
verbatim from ADK's own Temporal plugin page. Let it sit for a beat.
-->

---

## The ledger, part 2 — and what you still don't get

| Axis | **ADK + Temporal** | **Loom** |
|---|---|---|
| **Code shape** | 6 wrappers: `@activity.defn`, `activity_tool`, `TemporalModel`, `@workflow.defn`, plugin worker, client | a plain `async` function |
| **UI from the same log** | your problem | **projections** |
| **Branch a live execution** | ➖ | **fork / simulate / promote** |

> **They can do durability.** It just costs a server, a language, a preview-grade seam, two roadmaps, and your dev/prod parity — to reach where Loom starts.

---

## Side-by-side, by design axis

*Axes, not feature checkboxes — products move faster than slides.*

| Axis | Agent frameworks | Durable engines | **Loom** |
|---|---|---|---|
| **Unit of durability** | session checkpoint | workflow execution | **execution** |
| **The record** | app DB / vendor | engine cluster | **your event log** |
| **Replay model** | reload & re-drive | deterministic replay | **fold + memoized effects** |
| **Deployment** | library + infra | cluster or SaaS | **library; in-browser** |
| **Non-determinism** | inherent, unrecorded | quarantined | **first-class, recorded** |

---

## Where the competition wins — honestly

**Do not present the previous slides without this one.**

- **Temporal** — a decade of hardening, multi-language SDKs, mature ops tooling, proven at enormous scale, commercial support. **Loom is younger.**
- **ADK** — larger ecosystem, deeper tooling, live multimodal, a managed runtime, a far faster path to a first demo on GCP.
- **ADK + Temporal** — both, commercially supported. Already a Python/GCP Temporal shop? **The marginal cost is low.**
- **AI SDKs** — for a single-turn call they're the right tool. Loom would be ceremony.

> **Loom compounds with longevity, regulation, cost-per-step, portability.**

<!--
Presenter: deliver this one straight, without hedging or a "but". Conceding the
strong version of their case is what buys you the rest of the deck. If you need
one line to land it: "if you're a Python shop on GCP already running Temporal,
go use that — I'd rather you shipped."
-->

---

## Usually complementary, not competing

Loom is a **substrate**, not a rival agent library:

- Wrap an external agent (ADK, LangGraph, CrewAI) as a **durable effect** over A2A — it
  gains durability, replay, capability control, and audit.
- Call any tool over **MCP**; call any model through the provider seam.
- Use an AI SDK **inside** a step. Loom doesn't care what happens in there — only that
  it's recorded.

> **The question is rarely "Loom *or* X." It's usually "X, running on Loom."**

---

## Act V — Live demo

### Schema Migration Guard

> A migration request arrives → an agent **inspects** the table →
> a model **rates the risk** → risky migrations **pause for a human DBA** →
> on approval, it's applied.

**Four beats:**

1. **Live-code** the runner — `ctx.run`, `ctx.suspend`
2. **Run it** — it suspends at the gate
3. 💀 **`kill -9` the process** — and finish the job from a *different* one
4. **Time-travel** the log, then the **same flow** drives a React UI

<!--
Presenter: full runbook is ../../loom-demo/DEMO_SCRIPT.md.
Beat 3 is the new one and it is the single most persuasive thing in this talk:
  pnpm crash    → 2 steps execute, SIGKILL (exit 137), nothing flushes
  pnpm resume   → cold process, ONLY `apply` executes; the model call is not repeated
The count of ⚡ lines IS the proof. Point at it.
-->

---

## What the demo proved

```
process 1:   ⚡ inspect   ⚡ assess          ⏸ suspended      💀 SIGKILL (exit 137)
process 2:   ⚡ apply                        🎉 completed
```

- The second process **never saw the migration start**. It got a log file and an id.
- `inspect` and `assess` **did not re-run** — served from the log.
  **The model call was paid for exactly once.**
- The surface state that came back was reconstructed by folding events written by a
  process that no longer exists.
- Zero observability code was written. `loom logs` reads the log the flow already wrote.

> **That's "The one guarantee everything serves" — executed, not asserted.**

---

## Bottom line

> **Agent frameworks help you build an agent. Durable engines help a workflow survive.
> Loom is where those meet — and it's built for the fact that the workload is
> non-deterministic.**

- **What it is** — a durable execution kernel; the log is the source of truth
- **What it's for** — long-running, human-in-the-loop, auditable, expensive-step AI work
- **How it differs** — one substrate for durability + agents + UI · non-determinism as a
  *seam* · branchable live executions · **a library, not a platform**

**You don't add durability, auditability, or reproducibility later. They're the substrate.**

---

## A note on fairness

- Every product named here is **good at what it does**. The comparisons are about **architectural layer and design center**, not quality.
- This landscape moves **very fast**. The ADK/Temporal specifics here were verified against vendor docs in **September 2026** — Python-only and flagged experimental at that time.
- **Re-verify before quoting a slide at someone.**
- Loom's claims trace to shipped code, ADRs, and `docs/spec/`. If a slide can't, cut it — **an overclaim costs more than it wins.**

---

## Questions

**Try it:**

```bash
cd loom-demo
pnpm install && pnpm crash && pnpm resume
```

| Want more? | Where |
|---|---|
| The full positioning argument | [`loom-positioning-deck.md`](./loom-positioning-deck.md) |
| ADK in depth | [`loom-vs-adk-deck.md`](./loom-vs-adk-deck.md) |
| How the machinery works | [`architecture-deck.md`](./architecture-deck.md) |
| What we guarantee, normatively | [`../spec/loom-kernel-specification.md`](../spec/loom-kernel-specification.md) |
| The demo runbook | `loom-demo/DEMO_SCRIPT.md` |

<!--
Likely questions and short answers:

Q: "Isn't this just Temporal in TypeScript?"
A: Deployment shape and design center. Library vs server; records
   non-determinism vs quarantines it. See the "vs. Temporal" and
   "What the integration had to do" slides.

Q: "How do you handle a flow whose code changed between suspend and resume?"
A: `loom deploy check` replays real logs against new code and fails a
   resume-breaking change before it ships. Event schema + syscall ABI are pinned
   and CI fails on undocumented drift.

Q: "What's the throughput?"
A: Measured ~5.7K durable executions/sec; the append log is the bottleneck, not
   the interpreter. See docs/scaling.md. Temporal beats us at mega-scale today —
   say so.

Q: "Who's using it in production?"
A: Be honest. It's young. The examples in the repo are real and run; the
   production track record is Temporal's advantage, not ours.

Q: "Why not LangGraph checkpoints?"
A: A checkpoint is a snapshot you reload; a fold is computation you reconstruct.
   Memoization of individual effects is the difference you feel on a crash after
   an expensive call.
-->
