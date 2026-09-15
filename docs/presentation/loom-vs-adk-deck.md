---
marp: true
theme: default
paginate: true
title: "Loom vs Google ADK 2.0 — the durable-execution advantage"
---

<!-- _paginate: false -->

# Loom vs Google ADK 2.0

## What a durable-execution kernel brings that an agent SDK doesn't

**Both build agentic software. They sit at different layers — and that's the whole story.**

<!--
Presenter framing: ADK is an excellent agent-authoring SDK. Loom is a durable-execution
RUNTIME. The comparison isn't "which agent library is nicer" — it's "what happens to your
agent when the process dies, the regulator calls, or you leave Google Cloud."

READ THIS BEFORE PRESENTING: re-verified against vendor documentation 2026-09-13. Four
claims the earlier version made are now FALSE or table stakes — see "What's table stakes now".
If you are holding an older printout, throw it away.
-->

---

## Fair framing: they're not the same layer

| | **Google ADK 2.0** | **Loom** |
|---|---|---|
| **What it is** | An SDK to *author & orchestrate* agents | A *durable-execution runtime* |
| **Analogy** | Rails/Express for agents | An OS for long-running agentic work |
| **Runtime of record** | Session service + where you deploy | The **event log** — yours, anywhere |
| **Primary strength** | Fast to ship agents on Google Cloud | Durability, replay, compliance, portability |

> Argued **honestly**: first what ADK now does natively, then what's actually left.

---

## What ADK 2.0 does well (credit where due)

- **Python, TypeScript and Go — all GA.** Not a Python-only SDK any more.
- **It is event-sourced.** `ResumabilityConfig` gives replay-based resumption, and **completed tool results are returned from event history** — effect memoization, natively, with no engine attached.
- **Long-running and human-in-the-loop pauses are first-class.**
- **First-class Gemini + Vertex** — models, grounding, managed **Agent Engine** deployment.
- **Rich toolkit** — `LlmAgent`, Sequential/Parallel/Loop agents, agent-as-tool, MCP + OpenAPI, live audio/video, sessions & memory, callbacks, eval harness.

**If your world is Google Cloud + Gemini and you want an agent shipped this week — ADK is superb.**

---

## What's table stakes now

**Say this before claiming anything.** Solved, by several people, today:

- **An append-only history of what happened** — ADK, Temporal, Dapr, Diagrid
- **Replay after a crash** — resume from the last completed step
- **Memoized model and tool calls** — *"no duplicate LLM calls"*, natively in ADK 2.0
- **Durable human-in-the-loop pauses** — first-class in ADK 2.0

> **"We record what the model returned instead of re-running it" is no longer a differentiator.** It's the price of entry. Everything after this slide is what's left.

<!--
This slide costs you something on purpose, and it is the most important one here.
An engineer who knows this space is sitting there with a list of things that are already
solved. Claim them and you lose the room; concede them first and you get to spend your
credibility on what's actually left.
SAY: "an earlier version of this deck claimed all four of these. I can't any more."
ALSO RETIRED: the "they had to patch ADK's clock and UUID generator" line. Those seams
were upstreamed INTO ADK 2.0 as a platform package precisely so any engine can substitute
deterministic equivalents. Do not use it.
-->

---

## What Loom is

A **durable-execution kernel** for agentic apps: every step is an event, the log is the source of truth, execution is a **pure fold** of that log.

- **Suspend/resume that survives process death** — mid-flow, on any machine, byte-identically.
- **Deterministic replay** with **memoized effects** — time-travel over *computation*.
- **A hardened kernel** — capabilities, quotas, egress isolation, fencing, tenancy, data protection.
- **Vendor-neutral** — any model, any storage, any compute; no SaaS lock-in.

**AI calls are just effects — durable, replayable, and auditable like everything else.**

---

## The core difference in one line

> **ADK gives you the *ability* to resume. Loom gives you the *automation that notices you should* — and makes the whole multi-day, human-in-the-loop execution a fold over one log.**

An agent SDK asks: *how do I compose agents and tools?*

A durable-execution runtime asks: *who re-drives step 7 of 12 at 3am when nobody is watching?*

---

## Advantage 1 — Whose state machine is it?

| | **ADK 2.0** | **Loom** |
|---|---|---|
| **Resume unit** | session + **a state machine you maintain** | the execution, as a fold |
| **On crash** | *the caller must detect it and re-invoke* | supervisor + fencing re-drive it |
| **Scope** | agents you author in ADK | any `async` function |

Google's own long-running-agents guide grounds resumability in an **explicit state machine you maintain in session state** — you write `current_step` into the prompt.

> The gap isn't "ADK can't resume." It's that **you** hold the state machine and **you** notice the crash.

<!--
SAY: "ADK 2.0 is genuinely event-sourced and completed tool results come back from event
history. That's memoization. I'm not going to pretend otherwise." Then this slide.
The "on crash" row is Diagrid's published critique of ADK, not ours.
IF PUSHED ("your supervisor can die too"): concede immediately, it is true. Loom's
detection lives in the dispatcher's process — IN-PROCESS supervision, not durable
supervision. The row still holds (ADK has no automatic redispatch at all; loom does, and
recovers executions whose supervisor died) but do not defend it past that line.
-->

---

## Advantage 2 — A fold, not a reload

- Replaying a Loom execution is a **pure fold** of its events (P2) — the same function that ran it.
- **Time-travel debugging:** fold to *any* sequence and inspect exact past state (`loom debug --at N`).
- **Deploy safety:** `loom deploy check` replays real logs against new flow code and fails a resume-breaking change **before** you ship.

> Reconstructing a *conversation* from session events and reconstructing a *computation* from a fold are different problems. The second one can refuse to diverge silently — and does.

---

## Advantage 3 — The event log *is* the state

- One append-only log is **state + audit trail + replay tape** at once — no separate "state store vs. audit system".
- Every decision, effect, suspension, approval and denial is a durable, ordered fact.
- Storage is **pluggable and yours**: embedded SQLite, your Postgres, your object store — the audit log lives where you trust it, not in a vendor's session service.

**You don't add auditability later. It's the substrate.**

---

## Advantage 4 — Branch a live execution

- **Fork the log** at any point, run alternatives, **simulate**, **promote** the winner — state is `fold(events)`, so a branch is nearly free and the loser stays immutable as lineage.
- What-if incident remediation, schema-migration dry-runs, A/B of agent strategies **on real state**.

*(Incident War Room, Schema Migration Planner — shipped examples.)*

> Dapr has conditional branching: ordinary `if` statements replayed deterministically. That is not forking the log to explore alternatives. **Fork-and-simulate is genuinely unoccupied.**

<!--
The strongest of the three remaining claims — defend it, it's checkable.
ONE HONEST LIMIT if asked "can each branch wait on a different human?": yes, a fork of a
suspended execution is independently resumable by design — but neither shipped example
exercises a gate INSIDE a branch, and three things around it are app-level work today
(fork doesn't re-register the branch's timer, an approval carries no branch address, and
promote is a pointer move that doesn't retract the losing branches' outstanding asks).
Say "the primitive is there, the human-task plumbing is yours" rather than overclaiming.
-->

---

## Advantage 5 — Decisions carry their propensity

Everyone records **what** the model returned. A Loom `ctx.decide` also records the **policy** and the **probability that choice was drawn with**.

- That makes a decision evaluable **counterfactually, later, off real logs** — "what would a different policy have scored?" without re-running anything (`@loom/learning`).
- Propensity **cannot be reconstructed after the fact**. If it wasn't logged at the draw, it's gone.

**A bare decision log *looks* scored while being unevaluable. That's the difference.**

---

## Advantage 6 — A hardened kernel, not just an SDK

Execution-layer guarantees ADK largely delegates to the cloud platform:

- **K2 capabilities** — least-privilege: a step may only use effects it was granted.
- **K3 quotas / metering** · **K7 egress isolation** (allowlist, DNS-rebind-safe) · **K9 fencing** (a zombie predecessor can't double-write).
- **K12 identity & tenancy** — authenticated principal chains, verifiable delegation, per-tenant isolation by construction.

**Portable guarantees that travel with the runtime — your laptop, your Postgres, or Cloud Run.**

---

## Advantage 7 — Data protection is a primitive

What regulated teams feel first: **durable logging without the PII liability**.

- **Classify once** (`secret`/`sensitive`/`internal`/`externalized`) → encryption, redaction and egress scrubbing derive automatically.
- **Crypto-shredding + retention** — satisfy erasure by destroying a key; bound log lifetime.
- **GDPR/CCPA subject rights** — subject index, export (Art. 15/20), erasure (Art. 17), tenant-scoped.
- **Content-store seam** — externalize large/PII payloads so the authoritative log stays thin.

**Framework primitives in Loom. In an agent SDK they're your problem.**

---

## Advantage 8 — Vendor neutrality

| Dimension | ADK's happy path | Loom |
|---|---|---|
| **Models** | Gemini / Vertex (LiteLLM otherwise) | any provider, swappable per call |
| **Persistence** | Managed session/memory services | your SQLite / Postgres / object store |
| **Compute** | Vertex Agent Engine / Google Cloud | in-process, remote worker, Cloud Run |
| **The record** | the runtime you deployed to | the event log, wherever you keep it |

**Adopt Loom without adopting a cloud. Your durable state never leaves your trust boundary.**

---

## "Fine — ADK **plus** an engine."

### Two real answers, and you should take both seriously.

**ADK + Temporal** — an official integration that pushes every LLM call and tool invocation into its own Activity: durability *inside* the agentic loop.

**Diagrid Catalyst** — one execution model across **10+ frameworks** (ADK, LangGraph, CrewAI, OpenAI Agents, Strands…), built on Dapr, hosted **or** self-hosted. Memoizes completed model and tool calls, signs every step.

> If you're already on Temporal or Dapr, **these are rational choices and this deck has to beat them, not ignore them.**

<!--
Straight face, real respect. Sneer at either and you lose every senior engineer in the
room. This is the first thing a sharp room raises, so raise it first.
-->

---

## The cost of the combination

The capability is real. **The bill is what differs.**

| | **ADK + engine** | **Loom** |
|---|---|---|
| To get durability | a running server / control plane | a dependency |
| Dev/prod parity | *"you won't get the benefits of durable execution"* running locally | same runtime in a test, a browser, prod |
| Code shape | wrap in activities / nodes | a plain `async` function |

<!--
This was always an adoption-cost argument rather than a capability argument, which is
exactly why it survived the fact-check intact — adoption cost is where the difference now
lives. The dev/prod parity quote is verbatim from ADK's own Temporal plugin page; it's the
row engineers react to, so let it sit for a beat.
-->

---

## Side-by-side — where ADK 2.0 leads

| Capability | ADK 2.0 | Loom |
|---|---|---|
| Author agents / tools / workflows | ✅ excellent | ✅ flows + effects |
| Gemini / Vertex integration | ✅ deep | ➖ any model |
| Live multimodal streaming | ✅ | ➖ roadmap |
| Managed cloud deployment | ✅ Agent Engine | ➖ self-host |
| Languages GA | ✅ Python · TS · Go | ➖ TypeScript |
| Event-sourced history, memoized tool calls | ✅ native | ✅ |
| Durable human-in-the-loop pause | ✅ | ✅ |

---

## Side-by-side — where the runtime leads

| Capability | ADK 2.0 | Loom |
|---|---|---|
| Resume without a state machine you maintain | ➖ explicit `current_step` | ✅ fold |
| Automatic re-drive after a crash | ➖ caller re-invokes | ✅ supervisor + fencing |
| Cheap durable branching / simulation | ➖ | ✅ |
| Decisions carry policy + propensity | ➖ | ✅ |
| Capability / egress / tenancy kernel | ➖ platform | ✅ built-in |
| GDPR rights + crypto-shredding | ➖ DIY | ✅ primitive |
| Neutral storage / compute / model | ➖ | ✅ |

---

## Where ADK 2.0 is the better choice (honest)

- You're **all-in on Google Cloud + Gemini** and want the shortest path to a deployed agent.
- You need **live bidirectional audio/video** streaming today.
- You want a **fully managed runtime** (Agent Engine) and don't want to operate anything.
- You want the **bigger ecosystem and three GA languages** — Loom is TypeScript, and younger.
- Your workloads are **short-horizon** — replay, branching and erasure aren't yet pressing.

**Loom's advantages compound with *longevity, regulation, scale and portability*. For a quick Gemini agent on Vertex, ADK wins on speed-to-first-demo.**

---

## They can be complementary

Loom is a **substrate**, not a competing agent library:

- Wrap an **ADK agent as a Loom `A2AEffect`/tool** — it gains replay, capability control, egress isolation and compliance around it, over an open protocol (ADK ships native `to_a2a`).
- Use Loom where the *execution* must be durable, auditable, branchable and erasable; use ADK where you want its Gemini tooling inside a step.

**"Which agent SDK" is a smaller question than "what runtime is your agentic system built on."**

---

## Bottom line

> **ADK helps you *build* an agent — and now resumes one too. Loom guarantees the agentic *system* survives crashes, audits, regulators and cloud migrations.**

- Resume as a **fold**, not a state machine you maintain — plus something that notices the crash
- Cheap durable **branching**: fork a live execution, simulate, promote
- Decisions that carry **policy + propensity**, so they stay evaluable later
- Hardened kernel: capabilities, isolation, tenancy · data protection and GDPR built-in
- A **dependency**, not a platform: the same runtime in a unit test, a browser, and prod

---

## A note on fairness

- **Competitive facts re-verified 2026-09-13** against vendor documentation. ADK moves fast — **verify before quoting a slide**. Same analysis in talk form: `sip-n-pitch-deck.md`.
- **Two arguments were retired.** That ADK durability is "a session snapshot you reload" (it is event-sourced and memoizes tool results), and "they quarantine non-determinism, we record it" (those seams are now upstream in ADK 2.0).
- **Loom claims are grounded in shipped code + ADRs in this repo** — durable suspend/resume, deterministic fold, fork/promote, propensity logging, K2–K12, data protection.
- The goal is an *honest* architectural comparison, not a takedown. The two often belong at different layers of the same system.
