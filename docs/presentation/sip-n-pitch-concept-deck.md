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

**2. Non-determinism is allowed — but only if it's logged.**
A model call, a routing choice, a sample: record it as a durable fact, and serve
it **from the log** on replay. Never recompute it.

> Classical engines treat non-determinism as a **hazard to quarantine**.
> For AI work, non-determinism *is the payload*. So give it a seam instead.

<!--
THE most important slide in the deck — everything in Act IV turns on it. Plant
it here so you can harvest it there.
SAY: "Workflow engines spent a decade learning to keep non-determinism OUT of
the workflow path. That was correct for bank transfers. I think it's backwards
when the non-deterministic thing is the entire point of your program."
The payoff — if the bet holds you get a property that sounds contradictory:
"a given execution replays bit-for-bit forever, while outcomes improve run to
run." Say that and let it sit.
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

## Three categories, and the gap I think exists

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
                              ???  the seam  ???
```

**Both categories are genuinely good. My bet is that the interesting problems
live in the seam — and that's the part I need you to pressure-test.**

<!--
30 seconds, orientation only.
The "???" is deliberate — don't put your own name in the gap. The room should
decide the gap exists before you claim to stand in it.
EXPECT: "isn't that a gap you invented so you could sit in it?" — the best
question you'll get all night. Say so, and say the next three slides are your
attempt to answer it with evidence rather than assertion.
-->

---

## Google ADK — a different layer

**A genuinely excellent agent-authoring SDK** — deep Gemini/Vertex integration,
workflow agents, built-in tools, live multimodal, a managed runtime.

| | **ADK** | **The bet** |
|---|---|---|
| What it is | SDK to *author* agents | a *runtime* for executions |
| Unit of durability | session snapshot you reload | **the execution** |
| Resume | reload a session, re-drive | **fold + memoized effects** |

> Composing agents and *surviving a crash at step 7* are different problems.
> ADK is very good at the first one.

<!--
Lead with the credit and mean it — people here have shipped ADK agents and you
need them curious, not defensive.
Only one row matters: UNIT OF DURABILITY.
SAY: "a session is a snapshot you reload. An execution is a computation you
reconstruct. Identical on the happy path; completely different when you crash
mid-tool-call."
LANDMINE: never say ADK has no persistence or no human-interrupt support. It has
both and someone here knows it. The claim is narrower and survives scrutiny.
-->

---

## Temporal — the same goal, a different shape

**Temporal is the real thing.** A decade of hardening, deterministic replay,
signals, timers, multi-language SDKs, enormous scale. On durability they have
nothing to prove, and I'm not pretending otherwise.

| | **Temporal** | **The bet** |
|---|---|---|
| Deployment | a **server/cluster** you run or buy | **a library** |
| Design center | deterministic transactions | **non-deterministic AI work** |
| Non-determinism | **quarantined** into Activities | **recorded as a fact** |

<!--
Give them the full decade, with no hedge.
SAY: "if this room concludes 'just use Temporal', that is a completely
defensible engineering decision and I'd rather you shipped than waited for me."
Saying that out loud is what earns you the next two slides.
Then the two rows that actually differ: deployment shape and design center.
The second one is the real argument, and it's the one the next slide pays off.
-->

---

## "So use ADK **and** Temporal."

### Someone already built exactly that. It's good.

Temporal ships an official ADK integration — and it's well designed. It pushes
**every LLM call and tool invocation into its own Activity**: durability *inside*
the agentic loop, not a wrapper around it.

`TemporalModel` · `activity_tool` · `GoogleAdkPlugin`

**If you're a Python shop on GCP already running Temporal, that is a rational
choice and my bet has to beat it — not ignore it.**

<!--
Say this with a completely straight face and real respect. If you sneer here you
lose every senior engineer in the room, permanently.
This slide also proves you did your homework, which in a concept pitch is worth
more than any feature claim — it says "I looked for prior art before I fell in
love with my idea."
The argument happens on the NEXT slide, and it's an architectural observation,
not a dunk.
-->

---

## …and what they had to do is my best evidence

To run ADK inside a Temporal workflow, the integration **had to patch ADK's clock
and UUID generator** — new `google.adk.platform.time` / `.uuid` seams, so Temporal
could substitute deterministic equivalents on replay.

> Read that as a **design center**, not a criticism.
> A classical engine must *make the agent deterministic*, because non-determinism
> is a hazard it quarantines.

**That's the seam I think is real.** The bet says: don't remove the
non-determinism — **record what it returned.**

<!--
The intellectual core of the talk. If you land one slide in Act IV, land this.
SAY: "Two excellent teams met in the middle, and the price of the meeting was
patching the clock of an agent framework. That's not a bug — it's two design
centers grinding against each other. And it's the most concrete evidence I have
that the gap isn't imaginary."
It's checkable — the ADK PR adding those seams is public. Offer that if pushed.
LANDMINE: do NOT say this makes Temporal wrong. For deterministic business
transactions, quarantining is the CORRECT design. The claim is narrow: when the
non-determinism is the payload, a seam may beat a quarantine. "May". You're
testing it, not announcing it.
-->

---

## Where the existing answers are simply better

**If I skip this slide, you should stop believing the last four.**

- **Temporal** — a decade of production hardening, multi-language SDKs, real ops
  tooling, proven at scale, commercial support. **I have none of that.**
- **ADK** — bigger ecosystem, deeper tooling, managed runtime, far faster path to
  a working agent.
- **ADK + Temporal** — both, commercially supported, available today.
- **AI SDKs** — for a single-turn call they're simply right.

> **Nobody was ever fired for choosing the boring, proven thing. That's not a
> joke — it's the correct default, and my idea has to beat it on merits.**

<!--
Deliver straight, no "but". This slide is the entire credibility of the concept
pitch, and in a room of engineers it will do more for you than any advantage
slide.
If you're tight on time, cut something else. Not this.
GOOD LINE if the room is skeptical: "I'd rather leave here with three people
telling me why this is wrong than thirty nodding."
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
no hosted service · no published package · no multi-language SDKs · no ops story
· **no users**

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

- **Durable engines absorb the AI-native seams** — and Temporal's ADK
  integration is *already* a move in that direction
- **Agents stop being long-running** — if models get fast and cheap enough that
  re-running from scratch is simply free
- **Cost-per-step collapses** — memoization stops mattering
- **The ergonomics don't survive** real teams writing real flows

> A bet you can't lose isn't a bet. **These are the conditions where I'm wrong.**

<!--
This is the slide senior people remember, and the one that most often turns a
skeptic into an ally.
Name the first bullet specifically — conceding that your strongest competitor is
already moving into your gap is disarming precisely because it's true, and
pretending otherwise would be the easiest thing in the world to catch you on.
SAY: "If durable engines keep going the way that integration is going, the gap
closes on its own and the right answer is to help them instead."
-->

---

## What I'm actually asking for

**Not adoption. Collaborators.**

- Do you have a workload that **pauses for a human for more than an hour**? I want
  to test the bet against something I didn't design for.
- Do you want to **try to break the guarantee**? `kill -9` it in a way I haven't
  thought of.
- Do you disagree with the **"record, don't quarantine"** rule? That's the load-bearing
  claim — I'd rather find out now.

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

- Every product named here is **good at what it does**, and several overlap with
  this idea in real ways. The comparisons are about **architectural layer and
  design center**, not quality.
- The ADK/Temporal specifics were checked against vendor documentation in
  **September 2026** — Python-only and flagged experimental at that time.
- **This moves fast. Verify before you repeat any of it**, including from me.
- Nothing here is a product claim. There is no package to install and no user to
  reference.

<!--
Never delete this slide; presenting it is optional.
If time is tight, skip it but say the one line out loud: "everything I claimed
about other people's software tonight was checked against their own docs this
week — verify it before you repeat it, because I could be out of date by next
month."
That sentence costs nothing and buys you the benefit of the doubt on everything
else you said.
-->
