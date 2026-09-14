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

> Most durable engines now do a version of this. The unusual part:
> **a recorded decision also carries the policy and the propensity it was chosen with** — so it can be scored counterfactually, later, off real logs.

<!--
Rule 2 used to be pitched as the thing nobody else does. That's no longer true —
Temporal, Dapr and Diagrid all record effect results and replay them, and ADK
2.0 returns completed tool results from event history.
So plant the NARROW version here: the mechanism is table stakes; the propensity
on the decision record is not. You harvest it on "What's actually left".
If you say the broad version, the competitive section can't cash it.
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
paragraph on "Fine — a framework plus an engine". Never bluff a competitor's
feature set — see "A note on fairness".
-->

---

## The landscape moved — the seam has occupants

```
  ┌────────────────────────────┐          ┌────────────────────────────┐
  │  AGENT FRAMEWORKS          │          │  DURABLE ENGINES           │
  │  Google ADK 2.0 · CrewAI   │          │  Temporal · Dapr · Restate │
  │  LangGraph · OpenAI Agents │          │  Inngest · DBOS · Step Fns │
  └─────────────┬──────────────┘          └─────────────┬──────────────┘
                │        both moved toward the middle   │
                └──────────────┐         ┌──────────────┘
                               ▼         ▼
                ┌─────────────────────────────────┐
                │   DURABLE + AGENTIC             │
                │   Diagrid Catalyst              │
                │   ADK + Temporal                │
                │   ADK 2.0 natively (in part)    │
                └─────────────────────────────────┘
```

**In 2025 this was an empty seam. It isn't any more — so the argument has to be sharper than "we're in the gap."**

<!--
Orientation, and an honest correction if you've given this talk before: the
empty-seam version of this slide is out of date.
SAY: "When I started, I thought this middle box was empty. It isn't. Both
categories moved toward each other, and at least one company is standing
squarely in it. So let me tell you what everyone can now do, and then what I
think is actually left."
Leading with the correction is disarming and it buys you the next four slides.
Anyone who knows this space will otherwise be waiting to tell you.
-->

---

## Google ADK 2.0 — closer than it used to be

**Python, TypeScript and Go, all GA — and it is event-sourced.** `ResumabilityConfig`
gives replay-based resumption, and **completed tool results are returned from event
history**. That is effect memoization, natively, with no engine attached.

| | **ADK 2.0** | **Loom** |
|---|---|---|
| Resume unit | session + **a state machine you maintain** | the execution, as a fold |
| On crash | *the caller must detect it and re-invoke* | supervisor + fencing |
| Scope | agents you author in ADK | any `async` function |

> The gap isn't "ADK can't resume." It's that **you** hold the state machine and **you** notice the crash.

<!--
IMPORTANT: this slide was rewritten after checking ADK 2.0 directly. The old
version said ADK's unit of durability was "a session snapshot you reload" and
that it was Python-only. Both were out of date and someone would have caught it.
SAY: "ADK 2.0 is genuinely event-sourced, and completed tool results come back
from event history. That's memoization. I'm not going to pretend otherwise."
Then the real distinction, from Google's own long-running-agents guide: ADK
grounds resumability in an EXPLICIT state machine the developer maintains in
session state — you write `current_step` and interpolate it into the prompt.
That's a different thing from a fold over the log, and it's the honest claim.
The "on crash" row is Diagrid's published critique of ADK, not mine — ADK gives
you the ability to resume, not the automation that notices you should.
IF PUSHED ("your supervisor can die too"): concede it immediately, because it is
true. Loom's detection lives in the dispatcher's process, so it is IN-PROCESS
supervision, not durable supervision. The row still holds — ADK has no automatic
redispatch at all, loom does — but do not defend it past that line.
-->

---

## Temporal — the same goal, a different shape

**Temporal is the real thing** — a decade of hardening, deterministic replay, signals,
timers, multi-language SDKs, enormous scale. On durability they have nothing to prove.

| | **Temporal** | **Loom** |
|---|---|---|
| Deployment | a **server/cluster** you run or buy | **a library** |
| Runs in a browser tab | ➖ | ✅ same core |
| Design center | deterministic transactions | non-deterministic AI work |
| A model choice is… | an activity result | **a decision + its propensity** |

> Not "Temporal is wrong." **Temporal is a platform; Loom is a dependency.**

<!--
Give them the full decade, no hedge.
SAY: "if this room votes 'use Temporal', that's defensible and I'd rather you
shipped."
NOTE THE CHANGED ROW: this used to say "non-determinism: quarantined vs
recorded." That was overstated — Temporal records activity results and replays
them, which is functionally what Loom does with effects, and Loom's runner has
to be deterministic too. Do not make the quarantine argument; someone who knows
Temporal will take it apart and you'll lose the room.
The defensible version is the last row: everyone records WHAT came back, but a
Loom decision also carries the policy and the PROPENSITY — which is what makes
it evaluable counterfactually later. That's the narrow, true claim.
-->

---

## "Fine — a framework **plus** an engine."

### Two real answers, and you should take both seriously.

**ADK + Temporal** — an official integration that pushes every LLM call and tool
invocation into its own Activity: durability *inside* the agentic loop.

**Diagrid Catalyst** — the same execution model across **10+ frameworks** (ADK,
LangGraph, CrewAI, OpenAI Agents, Strands…), built on Dapr, hosted **or** self-hosted.
It memoizes completed model and tool calls, and signs every step.

> If you're already on Dapr, or already on Temporal, **these are rational choices and
> my argument has to beat them — not ignore them.**

<!--
Straight face, real respect. Diagrid especially: they're a serious company with
a CNCF-graduated foundation, and their blog post is literally titled "Durable
Execution: The Missing Runtime Primitive for Agents." They are not a strawman;
they're the strongest occupant of the box on the landscape slide.
If you sneer at either of these you lose every senior engineer in the room.
The argument happens on the next two slides, and it starts by CONCEDING the
capability rather than disputing it.
-->

---

## What's now table stakes

**Say this out loud before you claim anything.** All of these are solved, by several
people, today:

- **An append-only history of what happened** — ADK, Dapr, Temporal, Diagrid
- **Replay after a crash** — resume from the last completed step
- **Memoized model and tool calls** — *"no duplicate LLM calls"*, natively in ADK 2.0 and in Diagrid
- **Durable human-in-the-loop pauses** — first-class in ADK 2.0

> **"We record what the model returned instead of re-running it" is no longer a differentiator.**
> It's the price of entry. So what's left?

<!--
This is the most important slide in the new competitive section, and it costs
you something on purpose.
An engineer who knows this space is sitting there with a list of things that are
already solved. If you claim them, you lose. If you concede them first, you get
to spend your credibility on the three that are actually left.
SAY: "If I'd given this talk eighteen months ago I'd have claimed all four of
these. I can't any more, and I'd rather say so than have you tell me."
Then land the question — "so what's left?" — and go straight to the next slide.
-->

---

## What's actually left — three things

**1 · Shape.** Diagrid is a control plane and a data plane, even self-hosted. Temporal
is a cluster. ADK needs a session service *plus* your own supervisor.
**Loom is a dependency** — the same core runs in a unit test and a browser tab.

**2 · Branch a live execution.** Fork the log at a gate, simulate alternatives on real
state, promote one. Dapr has conditional branching; **nobody has fork-and-simulate.**

**3 · Decisions carry their propensity.** Everyone records *what* the model returned.
A Loom decision also records the **policy and the probability it was chosen with** — which
is what makes it evaluable **counterfactually**, later, off real logs.

<!--
The new spine of the whole section. Three claims, each one checked.
#1 is the sharpest and nothing on the landscape contests it.
#2 was verified specifically — Dapr's branching is ordinary if-statements
replayed deterministically, which is not the same as forking the log to explore
alternatives. If challenged, that's the precise distinction.
#3 is the one nobody expects and the one worth slowing down for. Everyone else
logs the OUTCOME. Loom logs the outcome, the policy that produced it, and the
propensity — so you can ask "what would a different policy have scored?" without
re-running anything. That's off-policy evaluation, and it's in @loom/learning.
If you only defend one thing in Q&A, defend this one. It's true and it's checkable.
-->

---

## The cost of the combination

The capability is real. **The bill is what differs.**

| | **Framework + engine** | **Loom** |
|---|---|---|
| To get guarantee #1 | a running server / control plane | a dependency |
| Dev/prod parity | ADK docs: running locally outside the engine ⇒ *"you won't get the benefits of durable execution"* | same runtime in a test, a browser, prod |
| Code shape | wrap in activities / nodes | a plain `async` function |

<!--
This survives the fact-check intact — it was always an adoption-cost argument
rather than a capability argument, and adoption cost is where the difference
actually lives now.
The dev/prod parity row is verbatim from ADK's own Temporal plugin page. It's
the row engineers react to, so let it sit for a beat.
A "two vendors' roadmaps" row was cut from this table on purpose: Diagrid
maintains its own integrations, so for Catalyst it's one vendor, not two. If
someone raises roadmap risk anyway, concede it rather than arguing — the
adoption-cost rows above are the ones that hold."
-->

---

## Side-by-side, by design axis

*Axes, not feature checkboxes — products move faster than slides.*

| Axis | Agent frameworks | Durable engines | **Loom** |
|---|---|---|---|
| **The record** | session store | engine cluster / service | **your event log** |
| **Deployment** | library + infra | cluster, sidecar or SaaS | **library; in-browser** |
| **Replay** | resume from saved state | deterministic replay | **fold + memoized effects** |
| **A decision records** | the outcome | the outcome | **outcome + policy + propensity** |
| **Fork a live run** | ➖ | ➖ | **✅ simulate & promote** |

<!--
Optional. 15 seconds — "this is the summary, photograph it, don't let me read
it to you."
Its only job is to still look defensible when someone screenshots one slide.
That's why the rows are now the four that survived the fact-check rather than
the eight I started with.
CUT ORDER: cut #2 if you're behind.
-->

---

## Where the competition wins — honestly

**Do not present the previous slides without this one.**

- **Temporal** — a decade of hardening, multi-language SDKs, real ops tooling, proven at scale, commercial support. **Loom is younger.**
- **Diagrid** — **ahead of us on attestation**: steps signed for public-key verification, lineage, SPIFFE identity over mTLS. Loom's audit chain is hash-chained and HMAC'd — tamper-*evident*, not third-party verifiable. Plus 10+ framework integrations.
- **ADK 2.0** — bigger ecosystem, three languages GA, managed runtime, far faster to a first agent.
- **AI SDKs** — for a single-turn call they're simply right.

> **Loom compounds with longevity, regulation, cost-per-step, portability.**

<!--
Deliver straight, no "but". This slide is the credibility of the whole section.
The Diagrid line is the important addition and you should say it without
flinching: on verifiable execution they are genuinely ahead of us, and that's a
checked comparison, not modesty. Hash-chain + HMAC detects tampering; signed
steps with a workload identity let a THIRD PARTY verify who produced what. Those
are different guarantees and theirs is stronger.
Conceding a real loss here is what makes "what's actually left" believable.
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

THE QUESTION THIS SLIDE ATTRACTS: "so who calls resume in production?" Have the
answer ready — it is in loom-demo/DEMO_SCRIPT.md in full, and short form is:
"here, me — I'm playing the supervisor. In a real deployment the dispatcher
redispatches a dead or wedged worker automatically (ADR 0004, tested). What that
misses is the supervisor itself dying, and for that there's `recoverAbandoned()`
— a pass you run from a cron, which makes YOU supply the 'is it orphaned?'
predicate, because a running execution on a healthy node looks identical in the
log to an orphaned one."
Do NOT claim the demo shows automatic recovery. It shows the RESUME is possible
from a cold process, which is the durability claim. Who triggers it is a
separate, answerable question.
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
- **Re-verified 2026-09-13** against vendor documentation — including a correction: ADK 2.0 is Python/TS/Go GA and natively memoizes tool results, and **Diagrid Catalyst now occupies the seam** this deck used to call empty.
- **This moves fast. Verify before you repeat any of it**, including from me.
- Loom's claims trace to shipped code, ADRs and `docs/spec/`. If a slide can't, cut it — **an overclaim costs more than it wins.**

<!--
Never delete this slide; presenting it is optional.
The re-verification bullet is worth saying out loud even if you skip the rest —
it tells the room you checked recently and corrected yourself, which is exactly
the posture that survives a hostile question.
If tight: "everything I claimed about other people's software was checked
against their own docs this week, and two of my slides changed as a result."
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
A: Do NOT answer "we record non-determinism, they quarantine it" — that
   argument doesn't survive contact with anyone who knows Temporal. The honest
   answer is three things: deployment shape (a dependency, not a cluster;
   it runs in a browser tab), forking a live execution to simulate
   alternatives, and decisions that carry their propensity so they can be
   evaluated counterfactually. See "What's actually left".

Q: "What about Diagrid / Dapr?"
A: The closest thing to this in the market, and say so. Durable execution
   across 10+ agent frameworks, memoized model calls, signed steps with SPIFFE
   identity — their attestation is ahead of ours. The difference is shape: a
   control plane and data plane versus a dependency. If they're already on
   Dapr, that's a rational choice.

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
