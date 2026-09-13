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

<!--
Divider — 5 seconds, don't linger.
SAY: "Three parts. The problem, the idea, and then the part you actually came
for — why not just use the thing you're already using. Hold the competitive
questions for about ten minutes and I promise I'll get there."
That promise is worth making: it stops the room from litigating Temporal
during Act I.
-->

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

<!--
SAY: "Everyone here has already picked one of these columns. If you picked the
left one, you've written a retry loop and a status column in Postgres and
called it durable. If you picked the right one, you've written YAML."
Usually gets the laugh, because it's true.
LAND: most teams end up building a bad version of the right column inside the
left one — and that's the thing this is trying to make unnecessary.
LANDMINE: do NOT name a vendor here. Naming Temporal now starts the argument
six slides early and you'll never get the thesis out.
-->

---

## Act II — The idea

<!--
Divider — keep moving.
SAY: "Now the idea. It's one sentence and one guarantee, and if you only
remember one slide tonight it's the one after next."
-->

---

## Loom, in one sentence

> **A durable execution kernel: a minimal, event-sourced core that runs long-lived,
> suspendable, replay-deterministic executions.**

Less formally:

> Your AI workflow becomes a **process that unfolds over time**, not a request that
> returns once — and every meaningful thing it does becomes an immutable fact in a log.

So it can **pause for a human, resume on another machine, replay bit-for-bit, fork to explore alternatives, and be audited against its own history.**

<!--
Say the formal sentence once, then immediately the informal one — the formal
one is for the skeptics, the informal one is what they'll repeat.
The phrase that lands: "a process that unfolds over time, not a request that
returns once."
Pause after "fork to explore alternatives" — nobody expects that one and you
want it to register before Act III.
IF ASKED "isn't this just event sourcing?": "Yes — applied to execution rather
than to domain state. The novelty isn't the log, it's that the call stack is a
fold of it." Then move on; don't teach event sourcing.
-->

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

<!--
First code on screen. SLOW DOWN — let them read before you talk.
Walk exactly three things, not the whole listing:
  1. ctx.run — a durable step. Recorded; on replay it's served from the log,
     never re-executed. Exactly-once without you doing anything.
  2. ctx.suspend — the entire human-in-the-loop story, in one line. It writes a
     checkpoint and hands control back. The approval can arrive in three days.
  3. What ISN'T here — no try/catch, no state machine, no queue, no status
     column, no `extends`.
THE LINE: "The process can die at any line on this slide, and none of this code
changes. That's the whole bet: plain async code, durability underneath."
LANDMINE: if asked about step$/handler$ — "compile-time extraction, it's in the
repo" — and move on. It's a twenty-minute rabbit hole and it isn't the point.
-->

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

<!--
One sentence first: "state is a fold over an append-only log."
Then work the diagram outward, not left-to-right:
  left column  = things you'd normally BUY separately
  right column = things you'd normally BUILD later, badly, under deadline
SAY: "Every arrow here is the same mechanism read through a different lens.
You don't integrate six systems. You append to one log."
Close on the last line and let it sit — "you don't add auditability later" is
the sentence that regulated-industry people write down.
-->

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

<!--
Divider — quick.
SAY: "So what does that actually buy you?"
-->

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

<!--
DO NOT read the table. They can read. Pick TWO and make them concrete:
  • Effect memoization — "you crash right after a four-dollar model call. On
    resume you don't pay for it again. That's not a feature we added; it's
    what 'served from the log' means."
  • Time-travel — "fold to sequence 6 and inspect the exact state, three days
    after it happened. A debugger for a workflow that runs for a week."
THEN: "Six line items you'd budget separately. One mechanism."
If the room is quiet, this is a good place to ask: "which of these have you
built by hand?" Most will say two or three.
-->

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

<!--
This is the most differentiating thing in the whole landscape and almost
nobody expects it. Give it room.
SAY: "Because state is a fold, a branch is just a shared prefix — the same
reason branching is cheap in git. So you can fork a live, in-flight execution
at the approval gate, run three different remediations against real state,
compare them, and promote one."
Note branch-only, no merge — and say WHY, because engineers will ask: merging
two divergent event histories has no sound semantics, so we didn't fake one.
Refusing to ship the unsound feature reads as credibility.
CUT ORDER: this is cut #1 if you're behind — BUT if there's a platform or SRE
person in the room, keep it and cut the side-by-side table instead.
-->

---

## Where Loom is the wrong tool

**Be honest about this before anyone asks.**

- A single-turn chat completion
- A stateless RAG lookup
- A cron job that can just re-run safely

Use the simple thing. **Loom's value compounds with longevity, cost-per-step, regulation, and blast radius** — not with cleverness.

> If your agent finishes in 900ms and re-running it is free, you do not need a kernel.

<!--
Deliver this unprompted, and early. It is the slide that buys you the entire
competitive section.
SAY: "I'm about to spend five minutes on why not to use the alternatives, so
let me first be honest about when not to use this."
Then the three bullets, flat, no hedging. Do not soften them with "but of
course..." — the value of this slide is that it costs you something.
THE LINE: "If your agent finishes in 900ms and re-running it is free, you do
not need a kernel. Use the simple thing."
-->

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

<!--
Orientation slide. 30 seconds, no more.
SAY: "Two mature categories. Both genuinely good. The claim is not that we beat
either one on its home turf — it's that the problems I care about live in the
seam between them."
Point at the seam as you say it.
EXPECT: "isn't that a gap you invented to sit in?" — fair question, and the
next three slides are the answer. Say that out loud rather than deflecting.
-->

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

<!--
Lead with the credit and mean it — several people in the room have shipped ADK
agents and you need them listening, not defending.
The only row that matters is UNIT OF DURABILITY. Everything else is context.
SAY: "A session is a snapshot you reload. An execution is a computation you
reconstruct. Those look identical on the happy path and behave completely
differently when you crash mid-tool-call."
LANDMINE: do NOT say ADK has no persistence or no human-interrupt support. It
has both, and someone here knows that. The claim is narrower — it's about the
unit of durability, not the presence of state.
-->

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

<!--
Give them the full decade. Do not get competitive here.
SAY: "If this room votes 'use Temporal' tonight, that is a defensible
engineering decision and I would rather you shipped."
Then two rows only: deployment shape and design center.
THE LINE: "Temporal is a platform; Loom is a dependency."
The browser-tab row usually gets a visible reaction — that's your evidence that
"library, not platform" is a real architectural property and not marketing.
If someone says "we already run Temporal" — good, that's the next three slides,
and you're not going to tell them they're wrong.
-->

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

<!--
Move faster than part 1. Part 1 was what it costs to get there; this is the
ceiling once you're there.
The CODE SHAPE row is the one engineers feel in their body: six wrappers versus
an async function. Say that and then just let them read it.
Land the blockquote close to verbatim — it's the thesis of the whole section,
and it concedes their capability while pricing it:
  "They can do durability. It just costs a server, a language, a preview-grade
   seam, two roadmaps, and your dev/prod parity — to reach where Loom starts."
-->

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

<!--
Optional. If you're on time, show it for 15 seconds and say: "this is the
summary — photograph it, don't let me read it to you."
Its only job is to still look defensible when someone screenshots one slide and
posts it in a Slack channel tomorrow. That's why it's axes, not checkmarks.
CUT ORDER: cut #2 (after the branching slide) if you're behind.
-->

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

<!--
De-escalation, and it's sincere — say it like you mean it, because it's true.
SAY: "The question is almost never 'Loom or X'. It's 'X, running on Loom'.
Wrap an ADK agent as a durable effect and it gets replay, capability control
and audit for free. Use an AI SDK inside a step — the kernel doesn't care what
happens in there, only that it's recorded."
This slide is what converts the last six from a sales pitch into an analysis.
If anyone has been getting defensive about their stack, this is where you get
them back. Watch for that and slow down if you see it.
-->

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

<!--
The most important non-competitive slide in the deck. Point at the COUNTS, not
the prose.
SAY: "Two lightning bolts in the first process. One in the second. That's the
entire argument, and you just watched it happen on my machine."
Then the line that actually lands it:
  "The risk assessment in that result was written by a process that no longer
   exists. It was rebuilt by folding the log."
And the giveaway: "I wrote zero observability code. loom logs is just reading
the log the flow already wrote."
If the demo broke and you're recovering here — this slide still works as a
narration of what they would have seen. Don't skip it.
-->

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

<!--
Close. No new information on this slide — resist the urge to add anything.
Say the blockquote as written; it's the one sentence you want them repeating at
the bar afterwards.
Then the final line slowly, and then STOP TALKING:
  "You don't add durability, auditability, or reproducibility later. They're the
   substrate."
Silence after a close is fine. Let them come to you.
-->

---

## A note on fairness

- Every product named here is **good at what it does**. The comparisons are about **architectural layer and design center**, not quality.
- This landscape moves **very fast**. The ADK/Temporal specifics here were verified against vendor docs in **September 2026** — Python-only and flagged experimental at that time.
- **Re-verify before quoting a slide at someone.**
- Loom's claims trace to shipped code, ADRs, and `docs/spec/`. If a slide can't, cut it — **an overclaim costs more than it wins.**

<!--
Never delete this slide; presenting it is optional.
If the room is senior, show it — it's the slide that retroactively makes
everything before it credible.
If you're tight on time, skip the slide but say the one line out loud:
  "Everything I claimed about ADK and Temporal tonight was checked against their
   own documentation this week. Verify it before you repeat it — this moves fast
   enough that I could be wrong by next month."
That sentence costs you nothing and buys you the benefit of the doubt on
everything else.
-->

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
