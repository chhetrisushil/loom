---
marp: true
theme: default
paginate: true
title: "Loom vs Google ADK — the durable-execution advantage"
---

<!-- _paginate: false -->

# Loom vs Google ADK 2.0

## What a durable-execution kernel brings that an agent SDK doesn't

**Both build agentic software. They sit at different layers — and that's the whole story.**

<!--
Presenter framing: ADK is an excellent agent-authoring SDK. Loom is a durable-execution
RUNTIME. The comparison isn't "which agent library is nicer" — it's "what happens to your
agent when the process dies, the regulator calls, or you leave Google Cloud."
-->

---

## Fair framing: they're not the same layer

| | **Google ADK 2.0** | **Loom** |
|---|---|---|
| **What it is** | An SDK to *author & orchestrate* agents | A *durable-execution runtime* for intelligent software |
| **Analogy** | Rails/Express for agents | An operating system for long-running, stateful agentic work |
| **Runtime of record** | The Google-managed runtime (Agent Engine / Vertex) | The **event log** — yours, anywhere |
| **Primary strength** | Fast to build & ship agents on Google Cloud | Durability, replay, compliance, portability |

> This deck argues Loom's advantages **honestly** — including where ADK is the better fit (slide 14).

---

## What ADK 2.0 does well (credit where due)

- **First-class Gemini + Vertex integration** — models, grounding, and managed **Agent Engine** deployment in a few lines.
- **Rich agent toolkit** — `LlmAgent`, workflow agents (Sequential / Parallel / Loop), agent-as-tool, built-in tools (search, code exec), MCP + OpenAPI.
- **Live multimodal** — bidirectional streaming, live audio/video.
- **Sessions, state & memory services**, callbacks/guardrails, and an evaluation harness.
- **Model-agnostic** (via LiteLLM) even if Gemini is the happy path.

**If your world is Google Cloud + Gemini and you want an agent shipped this week — ADK is superb.**

---

## What Loom is

A **QwikJS-like durable-execution kernel** for agentic apps: every step is an event; the log is the source of truth; execution is a **pure fold** of that log.

- **Suspend/resume that survives process death** — mid-flow, on any machine, byte-identically.
- **Deterministic replay** with **memoized effects** — no duplicate model calls; perfect time-travel.
- **A hardened kernel** — capabilities, quotas, egress isolation, fencing, tenancy, data protection.
- **Vendor-neutral** — any model, any storage, any compute; no SaaS lock-in.

**AI calls are just effects — so they're durable, replayable, and auditable like everything else.**

---

## The core difference in one line

> **ADK orchestrates an agent's turn. Loom makes the entire multi-step, multi-day, human-in-the-loop *execution* durable, replayable, and compliant.**

An agent SDK asks: *how do I compose agents and tools?*
A durable-execution runtime asks: *what happens when the process dies at step 7 of 12, three days into an approval wait?*

---

## Advantage 1 — Durability & resumability by construction

- **Loom:** `ctx.suspend()` writes a durable checkpoint; the execution lives entirely in storage. The process can crash, redeploy, or move machines — `resume(executionId, event)` continues **exactly** where it left off. Completed steps are never re-run.
- **ADK:** persists **session state + events** via a `SessionService`; resuming means reloading a session. A turn interrupted mid-tool-call isn't automatically memoized and continued — you re-drive it, and side-effects can repeat.

**Loom's unit of durability is the *execution*, not the session snapshot.**

---

## Advantage 2 — Deterministic replay + effect memoization

- Replaying a Loom execution is a **pure fold** of its events (P2). Effects already recorded are **skipped** — a crash after an expensive LLM/tool call never pays for it twice.
- **Time-travel debugging:** fold to *any* sequence and inspect exact past state (`loom debug --at N`).
- **Deploy safety:** `loom deploy check` replays real logs against new flow code and fails a resume-breaking change **before** you ship.

> Session-event replay in an agent SDK reconstructs a conversation; a deterministic **fold** reconstructs *computation* — and refuses to diverge silently.

---

## Advantage 3 — The event log *is* the state

- One append-only log is **state + audit trail + replay tape**, all at once — no separate "state store vs. audit system."
- Every decision, effect, suspension, approval, and denial is a durable, ordered fact.
- Storage is **pluggable and yours**: embedded SQLite, your Postgres, your object store — the audit log lives where you trust it, not in a vendor's session service.

**You don't add auditability later. It's the substrate.**

---

## Advantage 4 — Branching & speculation (git-for-execution)

- **Fork the log** at any point, run alternatives, **simulate**, and **promote** the winner — because state is `fold(events)`, a branch is nearly free.
- Enables "what-if" incident remediation, schema-migration dry-runs, and A/B of agent strategies **on real state**.

*(Incident War Room, Schema Migration Planner — shipped examples.)*

**No agent SDK gives you cheap, durable branching of an in-flight execution.**

---

## Advantage 5 — A hardened kernel, not just an SDK

Loom's kernel rings are execution-layer guarantees ADK largely delegates to the cloud platform:

- **K2 capabilities** — least-privilege: a step may only use effects it was granted.
- **K3 quotas / metering** · **K7 egress isolation** (allowlist + DNS-rebind-safe) · **K9 fencing** (a zombie predecessor can't double-write).
- **K12 identity & tenancy** — authenticated principal chains, verifiable delegation, per-tenant isolation by construction.

**Portable guarantees that travel with the runtime — on your laptop, your Postgres, or Cloud Run.**

---

## Advantage 6 — Data protection & compliance are primitives

The differentiator regulated teams feel first — **durable logging without the PII liability**:

- **Classify once** (`secret`/`sensitive`/`internal`/`externalized`) → encryption, redaction, and egress scrubbing derive automatically.
- **Crypto-shredding + retention** — satisfy erasure by destroying a key; bound log lifetime; never a silent divergence.
- **GDPR/CCPA subject rights** — subject index, export (Art. 15/20), erasure (Art. 17, liveness-gated), tenant-scoped.
- **Content-store seam** — externalize large/PII payloads so the authoritative log stays thin & PII-light.

**These are framework primitives in Loom. In an agent SDK they're your problem.**

---

## Advantage 7 — Vendor neutrality & no lock-in

| Dimension | ADK's happy path | Loom |
|---|---|---|
| **Models** | Gemini / Vertex (LiteLLM otherwise) | any provider, swappable per call |
| **Persistence** | Managed session/memory services | your SQLite / Postgres / object store |
| **Compute** | Vertex Agent Engine / Google Cloud | in-process, remote worker, Cloud Run — pluggable |
| **The record** | Google-managed | the event log, wherever you keep it |

**Adopt Loom without adopting a cloud. Your durable state never leaves your trust boundary.**

---

## Advantage 8 — Human-in-the-loop is a durable primitive

- A `HumanEffect` **suspends** the execution to a durable checkpoint; an approval can arrive **days later**, from any surface, and resume it deterministically.
- Approvals are **verifiable** (K12): "who approved" is signed evidence, not a claimed string — recorded as a durable `APPROVAL_GRANTED` fact.

**Multi-day approval workflows are the default case, not a bolt-on.**

---

## Side-by-side

| Capability | ADK 2.0 | Loom |
|---|---|---|
| Author agents / tools / workflows | ✅ excellent | ✅ (via flows + effects) |
| Gemini / Vertex integration | ✅ deep | ➖ (any model) |
| Live multimodal streaming | ✅ | ➖ (roadmap) |
| Managed cloud deployment | ✅ Agent Engine | ➖ (self-host / Cloud Run) |
| Crash-safe resume, memoized effects | ➖ session reload | ✅ deterministic |
| Deterministic replay / time-travel | ➖ | ✅ |
| Cheap durable branching / simulation | ➖ | ✅ |
| Capability / egress / tenancy kernel | ➖ (platform) | ✅ built-in |
| GDPR subject rights + crypto-shredding | ➖ (DIY) | ✅ primitive |
| Vendor-neutral storage / compute / model | ➖ | ✅ |

---

## Where ADK 2.0 is the better choice (honest)

- You're **all-in on Google Cloud + Gemini** and want the shortest path to a deployed agent.
- You need **live bidirectional audio/video** streaming today.
- You want a **fully managed runtime** (Agent Engine) and don't want to operate storage/compute.
- Your workloads are **single-turn or short-horizon** — durability, replay, and erasure aren't yet pressing.

**Loom's advantages compound with *longevity, regulation, scale, and portability*. For a quick Gemini agent on Vertex, ADK wins on speed-to-first-demo.**

---

## They can be complementary

Loom is a **substrate**, not a competing agent library:

- Wrap an **ADK agent as a Loom `A2AEffect`/tool** — get durability, replay, capability control, and compliance around it.
- Use Loom where the *execution* must be durable, auditable, and erasable; use ADK where you want its Gemini tooling inside a step.

**"Which agent SDK" is a smaller question than "what runtime is your agentic system built on."**

---

## Bottom line

> **ADK helps you *build* an agent. Loom guarantees your agentic *system* survives — crashes, audits, regulators, and cloud migrations — because durability, replay, and compliance are the kernel, not add-ons.**

- Durable & resumable by construction
- Deterministic replay + memoized effects
- Hardened kernel: capabilities, isolation, tenancy
- Data protection & GDPR built-in
- Vendor-neutral, no lock-in

---

## A note on fairness

- Google ADK evolves quickly; specifics here reflect ADK's **general design** (agent SDK + session services + managed Vertex runtime) as of this writing. **Verify current ADK capabilities before quoting a slide.**
- Loom claims are grounded in shipped code + ADRs in this repo (durable suspend/resume, deterministic fold, K2–K12 hardening, K10/T3 data protection, ADR 0046 content store).
- The goal is an *honest* architectural comparison, not a takedown — the two often belong at different layers of the same system.
