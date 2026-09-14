---
marp: true
theme: default
paginate: true
title: "Loom — a bet about how agents should run (concept pitch)"
---

<!-- _paginate: false -->

# Intelligence behaves like a process.

### Our tools still think it's a request.

**A bet I've been testing — and the spike I built to find out if it holds**

*Sip n Pitch · 30 min · this is an idea, not a product*

<!--
TIMING PLAN (30 min hard stop) — 33 slides (7 are section dividers)
  0:00  Act I    The itch            3 min  → "The moment it broke for me"
  3:00  Act II   The bet             4 min  → "The bet, in one sentence"
  7:00  Act III  What it predicts    3 min  → "If the bet is right..."
 10:00  Act IV   Am I reinventing?   5 min  → "Has someone already made this bet?"
 15:00  Act V    THE SPIKE          10 min  → loom-demo/DEMO_SCRIPT.md
 25:00  Act VI   Unknowns + the ask  4 min  → "What I still don't know"
 29:00  Q&A

POSTURE — this is the whole difference from the product deck. You are NOT
selling. You are saying: here is a bet, here is how I tested it, here is where
I might be wrong, who wants in. Every claim gets a hedge except the ones you
have actually run. Say "I think" and "my bet is" on purpose.

HONESTY FLOOR — do not let these slip, in the deck or in Q&A:
  • nobody uses this, including me, in production
  • it is not published; there is no package to install
  • the spike is a spike
If asked "how much is built?" — answer plainly: "more than a weekend, less than
a product. A kernel and some examples that run. None of it has met a real user."
Overclaiming here is the only way to lose this room.

CUT ORDER if you're running long, in this order:
  1. "More likely complementary than competing"
  2. "The prediction I didn't expect" (branching)
  3. "Why the log, specifically" (the diagram — the thesis survives without it)

NEVER cut these four. In a concept pitch they ARE the credibility, and cutting
any of them turns the talk back into a product pitch:
  • "Where I think the bet does not apply"
  • "Where the existing answers are simply better"
  • "What I still don't know"
  • "What would change my mind"
If you are SO short that the spike has to go, cut the talk instead — the
crash/resume is the only actual evidence you have.
-->

---

## Act I — The itch

<!--
Divider, 5 seconds.
SAY: "I want to start with the thing that annoyed me, because the whole idea is
downstream of one bad afternoon."
-->

---

## The shape of the work changed

AI moved inside things that:

- **run for a long time** — seconds to days, often pausing for a human
- **call expensive, fallible, non-deterministic services** — models, tools, agents
- **have to survive crashes, deploys, restarts** — without losing or repeating work
- **have to be explainable** — *why* did it do that? who approved it?

A single model call is a **request**. A multi-step agent is a **process**.

> Almost every tool I reached for was built for the first one.

<!--
Don't rush. If the room doesn't feel the request/process distinction, nothing
after this lands.
ASK FOR HANDS: "who has something in production that waits on a human?" Then:
"what happens to it if the pod is recycled while it's waiting?"
The answers are usually funny and slightly grim. That's your opening.
-->

---

## The moment it broke for me

An agent doing a multi-step job. Step 7 of 12. Three days into an approval wait.

The pod gets recycled.

- The work so far is **gone** — or worse, half-gone
- The expensive model calls get **paid for twice**
- Nobody can say **what it had already done**
- The fix is a retry loop, a `status` column, and a promise to be careful

> I did not want to write that code again. I wanted to know why I had to.

<!--
Tell this as a story, in first person, not as a bullet list. Twenty seconds.
The audience should recognise it — most of them have written the retry loop and
the status column, and several of them shipped it last quarter.
THE PIVOT LINE: "I wanted to know why I had to." That's what turns a war story
into a research question, and it sets up the whole rest of the talk as an
investigation rather than a product demo.
-->

---

## Everyone makes the same trade

| Reach for an agent framework | Reach for a workflow engine |
| --- | --- |
| ✅ easy to write | ✅ durable |
| ❌ forgets on crash | ❌ boilerplate / DSL |
| ❌ can't pause for humans | ❌ a server to operate |
| ❌ no replay | ❌ built to *forbid* non-determinism |

Most teams end up building a **bad version of the right column inside the left one**.

<!--
SAY: "Everyone here has picked a column. If you picked the left one you wrote
the retry loop. If you picked the right one you wrote YAML."
LANDMINE: do NOT name a vendor yet. Act IV is where that happens, and naming
Temporal now means you spend the next ten minutes arguing instead of explaining.
If someone shouts a vendor name anyway: "hold that — I've got three slides on
exactly that and I'd rather you judged them after you've heard the bet."
-->

---

## Act II — The bet

<!--
Divider.
SAY: "So here's the bet. One sentence, then one guarantee it has to deliver,
then what it would actually look like to write."
-->

---

## The bet, in one sentence

> **If every meaningful thing an execution does is appended to an ordered, immutable log — then durability, resume, replay, branching, audit and evaluation stop being features you build, and become lenses on one mechanism.**

Said smaller:

> Stop treating the agent as a call that returns. Treat it as a **process whose entire history is the state.**

**That's the bet. Everything else in this talk is me trying to break it.**

<!--
This is the thesis slide. Say the long version once — slowly, it's dense — then
the short version, which is the one they'll repeat.
THE POSTURE LINE: "everything else in this talk is me trying to break it."
That sentence reframes the next twenty minutes from a pitch into an
investigation, and it's why the competitive section won't feel defensive.
IF ASKED "isn't this just event sourcing?": "Yes — pointed at execution instead
of domain state. The novelty isn't the log. It's that the call stack becomes a
fold of it." Don't teach event sourcing; move on.
-->

---

## The one guarantee it has to deliver

If the bet is right, this has to be true — and it's the only thing I'd defend:

> A function can be interrupted at **any** point — waiting on a tool, a model, or a **human** — survive a process restart, and resume from exactly where it left off, **without the application code knowing the difference** between a fresh run and a replay.

**Everything else is negotiable. This isn't.**

If I can't deliver that sentence, the idea is wrong and I should stop.

<!--
Pause here. This is the falsifiable claim, and framing it as falsifiable is what
makes it a bet rather than a pitch.
SAY: "I picked this as the one thing to defend because it's testable. Either the
process can die and continue, or it can't. Act V is me trying it in front of
you."
That promise makes the demo land as EVIDENCE rather than a product tour — which
is the entire reason this deck exists.
-->

---

## What it would look like to write

```ts
const runner = async (ctx, input) => {
  const stats   = await ctx.run(inspectStep, input);   // durable step
  const verdict = await ctx.run(assessStep, stats);    // a real model call

  if (verdict.risk === "low") return ctx.run(applyStep, input);

  // Durable checkpoint. Persists, hands control back, may wait days.
  const decision = await ctx.suspend({ on: "ApprovalGranted" });

  if (!decision.approved) return { applied: false };
  return ctx.run(applyStep, input);
};
```

**No DSL. No state machine. No queue. No status column.** The process can die at
*any* line — on resume, the completed steps are **served from the log, not re-run**.

<!--
First code. SLOW DOWN, let them read before you talk.
Three things only:
  1. ctx.run   — a durable step; on replay it's served from the log, not re-run
  2. ctx.suspend — the whole human-in-the-loop story in one line; the approval
     can arrive in three days
  3. what ISN'T here — no try/catch, no state machine, no queue, no status column
THE LINE: "the process can die at any line on this slide, and none of this code
changes."
HEDGE IT, because this is a concept pitch: "this is the shape I think it should
have — this is from the spike, and I'd genuinely like to be argued out of the
`$`-suffixed bits."
-->

---

## Why the log, specifically

If state is `fold(events)` rather than a snapshot you mutate, six separate
problems collapse into one:

```
                     ┌──────────────────────────┐
   durability ◄──────┤                          ├──────► replay / time-travel
   resume     ◄──────┤    append-only event log ├──────► evaluation
   branching  ◄──────┤    state = fold(events)  ├──────► deploy-safety
   distribute ◄──────┤                          ├──────► audit
                     └──────────────────────────┘
```

**You don't add auditability later. It falls out.**

<!--
Work the diagram outward, not left to right:
  left  = things you'd normally BUY separately
  right = things you'd normally BUILD later, badly, under deadline
SAY: "every arrow is the same mechanism read through a different lens. That's
the part I find suspicious in a good way — when one idea claims six wins, it's
either a real abstraction or I'm fooling myself. That's what I wanted to test."
That doubt is doing real work. Keep it.
-->

---

## The part I think is actually new

Two rules. The first is ordinary. **The second is the bet.**

**1. State is a pure fold.** Never a snapshot you mutate.

**2. Non-determinism is allowed — but only if it's logged**, *and the log keeps the
reasoning, not just the result.* A model call records what came back **and** the policy
and probability it was chosen with.

> Recording the result is table stakes — several engines do it.
> Recording the **propensity** is what lets you ask, later, *what would a different
> choice have scored?* — without re-running anything.

<!--
Rule 2 was originally pitched as "engines quarantine non-determinism, I record
it". Cut that framing: Temporal, Dapr and Diagrid all record effect results and
replay them, and ADK 2.0 returns completed tool results from event history. It
was the weakest claim in the first draft.
PLANT THE NARROW VERSION HERE and harvest it on "So what's actually left?":
the mechanism is table stakes; the propensity on the decision record is not.
SAY: "everyone can replay what the model said. I want to be able to ask what a
different policy would have scored, using logs I already have. That needs the
probability, and you can't reconstruct it afterwards — you either wrote it down
at the time or you didn't."
That last clause is the real argument, and it's checkable.
-->

---

## Act III — What the bet predicts

<!--
Divider.
SAY: "A bet is only interesting if it predicts something you wouldn't otherwise
expect. Here's what this one predicts you'd get without building it."
Framing predictions rather than features is what keeps this a concept pitch.
-->

---

## If the bet is right, these are free

| Prediction | Why it follows from the log |
|---|---|
| **Crash anywhere, continue** | the log *is* the state |
| **Never pay twice** | a completed effect is served, not re-run |
| **Time-travel debugging** | fold to *any* point, inspect exact past state |
| **Deploy safety** | replay real logs against new code before shipping |

> Four things you'd normally budget separately. **If the bet is right, they're
> one mechanism — and if they don't fall out, the bet is wrong.**

<!--
Don't read the table. Pick TWO and make them physical:
  • never pay twice — "you crash right after a four-dollar model call. On resume
    you don't pay again. Not a feature I added — it's what 'served from the log'
    means."
  • time-travel — "fold to step 6 and look at the exact state, three days later."
THEN THE CONCEPT-PITCH MOVE: "these are predictions, not a feature list. If I
built it and they didn't fall out for free, that would be evidence against the
idea." That's the sentence that separates this from a product demo.
-->

---

## The prediction I didn't expect

Because a branch is just a **shared log prefix**, forking a *live, in-flight*
execution should be nearly free — like git.

```
   main   ──●──●──●──●─ suspended at the approval gate
                     ├──○──○──○   branch A: roll forward
                     ├──○──○──○   branch B: roll back      ← run all three
                     └──○──○──○   branch C: dual-write       on real state
                          ▲
                     promote the winner
```

**Fork → simulate → compare → promote.** Branch-only; no merge.

<!--
SAY: "I didn't set out to build this. It fell out of the fold, and that was the
moment I started taking the idea seriously — when it predicted something I
hadn't asked for."
That's the most honest argument for an abstraction, and it's far more persuasive
in a concept pitch than listing it as a feature.
WHY NO MERGE — say it, they'll ask: merging two divergent event histories has no
sound semantics, so I didn't fake one. Refusing to ship the unsound thing buys
you credibility.
CUT: this is cut #3 if you're behind — unless there's a platform/SRE person in
the room, in which case keep it and cut the side-by-side table.
-->

---

## Where I think the bet does *not* apply

**Say this before anyone asks, or the rest doesn't count.**

- A single-turn chat completion
- A stateless RAG lookup
- A cron job that can just safely re-run

The idea only earns its complexity with **longevity, cost-per-step, regulation,
and blast radius**.

> If your agent finishes in 900ms and re-running it is free, this is a bad idea
> and you should use the simple thing.

<!--
Deliver flat, unprompted, no hedging, no "but of course...". The value of this
slide is precisely that it costs you something.
In a concept pitch this matters double: an idea with no stated boundary reads as
enthusiasm rather than analysis. Naming the boundary is what makes you sound
like you've actually thought about it — because you have.
-->

---

## Act IV — Am I just reinventing something?

### The honest version of "competitive analysis"

<!--
Divider, and reframe explicitly — this is NOT a competitive smackdown:
SAY: "The first thing you do with an idea like this is go and find out whether
someone already had it and did it better. So: three categories, and whether the
gap I think I found is real or imaginary."
That framing means the rest of Act IV can be generous about competitors without
weakening your position — generosity IS the position.
-->

---

## Three categories — and the seam has occupants

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
                │   DURABLE *AND* AGENTIC         │
                │   Diagrid Catalyst              │
                │   ADK + Temporal                │
                │   ADK 2.0 natively (in part)    │
                └─────────────────────────────────┘
```

**I thought this box was empty. It isn't — and a bet has to survive that.**

<!--
This is where the concept pitch gets its credibility, so do NOT skip the
correction.
SAY: "When I started, I thought the middle was empty. It isn't. Both categories
moved toward each other, and at least one company is standing squarely in it.
An idea that only works if nobody else had it is a bad idea, so let me show you
what everyone can do now, and then what I think is still unclaimed."
A room that sees you correct your own landscape slide will believe the rest.
A room that catches you with a stale one won't believe any of it.
-->

---

## Google ADK 2.0 — closer than my bet assumed

**Python, TypeScript and Go, all GA — and event-sourced.** `ResumabilityConfig` gives
replay-based resumption, and **completed tool results come back from event history**.
That's effect memoization, natively, with no engine attached.

| | **ADK 2.0** | **The bet** |
|---|---|---|
| Resume unit | session + **a state machine you maintain** | the execution, as a fold |
| On crash | *the caller must detect it and re-invoke* | supervised, fenced |

> The gap isn't "ADK can't resume." It's that **you** hold the state machine and **you** notice the crash.

<!--
Rewritten after checking ADK 2.0 directly — the earlier version of this slide
was out of date and would have been caught.
SAY: "I have to correct something. ADK 2.0 is genuinely event-sourced and it
memoizes completed tool results. When I started this, that wasn't true."
Then the surviving distinction, from Google's own long-running-agents guide:
ADK grounds resumability in an EXPLICIT state machine the developer maintains
in session state. That's a real difference from a fold, but it's a smaller one
than I originally claimed, and saying so is the price of being believed.
-->

---

## Temporal — the same goal, a different shape

**Temporal is the real thing.** A decade of hardening, deterministic replay, signals,
timers, multi-language SDKs, enormous scale. I'm not pretending otherwise.

| | **Temporal** | **The bet** |
|---|---|---|
| Deployment | a **server/cluster** you run or buy | **a library** |
| Design center | deterministic transactions | non-deterministic AI work |
| A model choice is… | an activity result | **a decision + its propensity** |

<!--
Give them the full decade with no hedge.
SAY: "if this room concludes 'just use Temporal', that's defensible and I'd
rather you shipped than waited for me."
IF PUSHED on the "on crash" row ("your supervisor can die too"): concede it, it
is true. Loom's detection lives in the dispatcher's process — in-process
supervision, not durable supervision.
CHANGED ROW — this used to say "non-determinism: quarantined vs recorded". Cut
that argument: Temporal records activity results and replays them, and the Loom
runner has to be deterministic too. It was the weakest claim in the original
deck and the easiest to dismantle.
What survives is the last row, and it's narrow: everyone records WHAT came back;
the bet also records the policy and the propensity.
-->

---

## Someone already built this. Two someones.

**ADK + Temporal** — an official integration pushing every LLM call and tool invocation
into its own Activity.

**Diagrid Catalyst** — durable execution across **10+ agent frameworks**, built on Dapr (CNCF-graduated), hosted or self-hosted. Memoizes completed model and tool calls, and signs every step. Their blog post is titled *"Durable Execution: The Missing Runtime Primitive for Agents."*

> **That's my thesis, with a company behind it.** Which is either very bad news or the
> best validation I could ask for.

<!--
The most important slide in the concept deck, and the one that would be
tempting to leave out. Leave it in.
SAY it with a straight face: someone independently reached the same conclusion,
funded it, and shipped it across ten frameworks. If the idea were wrong, that
wouldn't have happened.
Then the honest pivot — and pause before it: "so the question stops being 'is
there a gap' and becomes 'why does a library-shaped version still matter?'
That's a harder question and it's the one I actually want your help with."
That reframe is the whole reason this variant of the talk exists.
-->

---

## So what's actually left?

**Table stakes now** — an append-only history · replay after a crash · memoized model
and tool calls · durable human pauses. Several people do all of it.

**What I think is still unclaimed:**

**1 · Shape** — a dependency, not a control plane. Same core in a unit test and a browser tab.
**2 · Forking a live execution** — simulate alternatives on real state, promote one. Dapr has conditional branching; nobody has fork-and-simulate.
**3 · Decisions that carry their propensity** — so a choice can be scored **counterfactually** later, off real logs, without re-running anything.

<!--
This replaces the old "they had to patch ADK's clock" slide, which is now stale:
those seams were upstreamed INTO ADK 2.0 as a platform package precisely so any
engine can do replay-safe events. Telling that story as friction would be
describing a problem that got fixed.
Concede table stakes FIRST — an engineer in this room already has that list, and
claiming any of it loses you the other three.
#3 is the one to slow down on and the one I'd defend in Q&A. Everyone logs the
outcome. Logging the policy AND the probability it was chosen with is what makes
off-policy evaluation possible. It's in @loom/learning and it's checkable.
If someone asks "why does that matter?" — because otherwise you can only learn
from what you did, never from what you didn't.
-->

---

## Where the existing answers are simply better

**If I skip this slide, you should stop believing the last five.**

- **Temporal** — a decade of hardening, multi-language SDKs, real ops tooling, proven at scale, commercial support. **I have none of that.**
- **Diagrid** — **ahead of me on attestation**: signed steps, public-key verification, lineage, SPIFFE identity over mTLS. Mine is hash-chained and HMAC'd — tamper-*evident*, not third-party verifiable.
- **ADK 2.0** — three languages GA, bigger ecosystem, managed runtime, far faster to a working agent.

> **Nobody was ever fired for choosing the boring, proven thing. That's the correct default, and my idea has to beat it on merits.**

<!--
Deliver straight, no "but". In a concept pitch this slide does more work than
any advantage slide.
The Diagrid line matters most: on verifiable execution they are genuinely ahead,
and that's a checked comparison rather than modesty. A hash chain detects
tampering; signed steps with a workload identity let a THIRD PARTY verify who
produced what. Different guarantees, and theirs is stronger.
GOOD LINE if the room is skeptical: "I'd rather leave with three people telling
me why this is wrong than thirty nodding."
-->

---

## More likely complementary than competing

If the bet is right, this is a **substrate**, not a rival agent library:

- Wrap an ADK or LangGraph agent as a **durable effect** — it gains replay,
  audit, and capability control
- Call tools over **MCP**; call any model through a provider seam
- Use an AI SDK **inside** a step — the runtime shouldn't care what happens in
  there, only that it's recorded

> The question is probably not "this *or* X". It's **"X, running on this."**

<!--
De-escalation, and it's sincere.
This is where you win back anyone who's been getting defensive about their
stack. Watch faces during Act IV; if you saw arms fold, slow down here.
SAY: "I'm not trying to replace the thing you like. I'm asking whether the thing
you like should be running on something that remembers."
-->

---

## Act V — The spike

### I built one to find out if the guarantee is real

<!--
Divider, and set expectations honestly BEFORE the terminal appears:
SAY: "I could have drawn this on a whiteboard forever. Instead I built a spike —
not a product, not a thing you can install. Just enough to find out whether the
one guarantee I said I'd defend is actually deliverable. Here's what happened."
That sentence is the honesty floor of the whole talk. Say it every time.
-->

---

## What I built — and what I deliberately didn't

**Built** — enough to test the guarantee:
a kernel where a step is an event, `ctx.suspend` writes a durable checkpoint, and
state is a fold. A few worked examples. A CLI that reads the log.

**Not built** — deliberately:
no hosted service · no published package · no multi-language SDKs · no supervisor
daemon · **no users**

> It is **more than a weekend and much less than a product.**
> Its only job is to answer one question: *does the guarantee hold?*

<!--
Say the "not built" list OUT LOUD and without flinching. In a concept pitch,
volunteering the gaps is what makes the demo believable ninety seconds later.
IF ASKED how long / how much: answer plainly and move on. Don't inflate and
don't self-deprecate — both read as insecurity. "Enough to answer the question,
not enough to hand you."
-->

---

## The test: can it survive its own death?

> A migration request arrives → an agent **inspects** the table →
> a model **rates the risk** → risky migrations **pause for a human** →
> on approval, it's applied.

**The experiment:**

1. Run it until it pauses at the human gate
2. **`kill -9` the process** — no cleanup, no flush, nothing
3. Finish the job from a **completely different process**

<!--
Full runbook: loom-demo/DEMO_SCRIPT.md (the concept framing changes what you SAY,
not what you run).
  pnpm crash    → 2 steps execute, then SIGKILL. Exit 137.
  pnpm resume   → cold process, ONLY `apply` runs.
Frame it as an EXPERIMENT with a predicted result, then run it. Predict out loud
before you hit enter: "if the bet is right, the second process does exactly one
unit of work. If it does three, I've wasted six months."
Stating the prediction first is what turns a demo into evidence. Do not skip it.
DON'T SKIP `echo $?` — engineers will assume you caught the signal. 137 is the
proof you didn't.
-->

---

## What the spike proved — and what it didn't

```
process 1:   ⚡ inspect   ⚡ assess      ⏸ suspended     💀 SIGKILL (exit 137)
process 2:   ⚡ apply                    🎉 completed
```

**Proved:** the guarantee holds. The second process never saw the job start —
`inspect` and `assess` were served from the log, and the model call was paid for
**exactly once, across a process death**.

**Did *not* prove:** that it's fast enough, operable, teachable, or right.

<!--
Point at the COUNTS, not the prose. "Two in the first process, one in the second.
That's the whole experiment."
THE LINE: "the risk assessment in that result was written by a process that no
longer exists. It was rebuilt by folding the log."
THEN — and this is the concept-pitch move that a product deck can't make —
immediately say what it did NOT prove. Volunteering the limit right after your
strongest moment is the single most credible thing you can do on stage, and it
sets up the next slide perfectly.
If the demo failed: this slide still works as narration. Don't skip it.

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

## Act VI — What I still don't know

<!--
Divider.
SAY: "So that's the good news. Here's the list that keeps me honest."
Don't apologise for this section. It's the reason the talk is worth giving.
-->

---

## The open questions

- **Does the log stay cheap?** Measured ~5.7K durable executions/sec on a laptop —
  and the *log* is the bottleneck, not the interpreter. Fine for approvals.
  Probably wrong for anything high-frequency.
- **Does "plain async code" survive a team?** No DSL means no guardrails.
- **Is replay-determinism achievable when the *control flow itself* is
  model-chosen?** I can record a decision. I'm less sure about a whole plan.
- **Is "runs in a browser tab" a real capability or a party trick?**
- **Nobody has run this in anger.** Including me.

<!--
Deliver these as genuine questions, not as humblebrags. The difference is
audible, and this room will hear it.
The throughput number is real and measured — if someone pushes, the log is the
bottleneck and that's a design consequence, not a tuning problem.
BEST OUTCOME: someone in the room has an opinion on one of these. That's not an
interruption, that's the point of the evening — let them talk, and write it down
in front of them. Visibly taking notes on a critique is worth more than any
slide.
-->

---

## What would change my mind

I'd drop this if:

- **Durable engines absorb the AI-native seams** — **this one is already happening.** ADK 2.0 took the determinism seams in-tree; Diagrid took the category.
- **Agents stop being long-running** — models fast and cheap enough that re-running is free
- **Cost-per-step collapses** — memoization stops mattering
- **The ergonomics don't survive** real teams writing real flows

> A bet you can't lose isn't a bet. **One of these is already partly true.**

<!--
This is the slide senior people remember, and it got stronger rather than weaker
when the facts changed.
Say the first bullet plainly and don't soften it: the condition I wrote down as
"what would change my mind" has partly fired, in public, since I wrote it. That
is exactly what an honest bet looks like from the inside.
SAY: "I'm not going to quietly delete the prediction that came true."
If someone asks whether you're abandoning it — no, but the remaining claim is
narrower than it was, and the three things on 'what's actually left' are what
I'd defend now.
-->

---

## What I'm actually asking for

**Not adoption. Collaborators.**

- Do you have a workload that **pauses for a human for more than an hour**? I want
  to test the bet against something I didn't design for.
- Do you want to **try to break the guarantee**? `kill -9` it in a way I haven't
  thought of.
- Do you think **propensity-on-the-decision** earns its cost? That's the load-bearing
  claim now — I'd rather find out it's wrong tonight.

> My own design rule: nothing becomes real until a **second, unrelated** use case
> needs it. **I need second use cases. That's the ask.**

<!--
THE CLOSE. Be specific — "let me know if you're interested" gets you nothing.
Ask for the three concrete things on the slide and then stop talking.
The second-consumer rule is a genuine discipline in the project, not a rhetorical
device, so say it as what it is: the reason you need other people is structural,
not social. That lands well with engineers.
Have a way for them to respond ready — a channel, your handle, a sheet. Don't
make "how do I follow up" their problem at the bar.
BEST OUTCOME TONIGHT: three real conversations, one of which tells you you're
wrong. Say that out loud if the room is warm.
-->

---

## The bet, one more time

> **Intelligence behaves like a process, not a request.**
> If you log everything a process does, durability, replay, audit and branching
> stop being features and become **one mechanism**.

- **The guarantee:** die anywhere, resume exactly, code can't tell
- **The evidence:** a spike that survives `kill -9`
- **The unknowns:** throughput, ergonomics, whether the gap closes on its own
- **The ask:** a workload I didn't design for, and someone to prove me wrong

<!--
Close. Add NOTHING new here — resist it.
Say the blockquote as written; it's the sentence you want repeated at the bar.
Then the four lines, then stop. Silence after a close is fine. Let them come to
you.
If you only get one sentence out before time is called, it's the first one.
-->

---

## A note on fairness

- Every product named here is **good at what it does**, and several overlap with this idea in real ways. The comparisons are about **architectural layer and design center**, not quality.
- **Re-verified 2026-09-13** against vendor documentation — and two slides changed as a result: ADK 2.0 is Python/TS/Go GA and natively memoizes tool results, and **Diagrid Catalyst occupies the seam** this deck used to call empty.
- **This moves fast. Verify before you repeat any of it**, including from me.
- Nothing here is a product claim. There is no package to install and no user to reference.

<!--
Never delete; presenting it is optional.
If tight on time, say one line: "everything I claimed about other people's
software was checked against their own docs this week, and two of my slides
changed as a result."
In a concept pitch that sentence is worth more than the slide — it's evidence
that you update on facts, which is the only reason to trust the rest.
-->
