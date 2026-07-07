---
marp: true
theme: default
paginate: true
title: "Loom — The Framework for Agentic Applications"
---

<!-- _paginate: false -->

# Loom

## The framework for agentic applications

**A platform for building durable, intelligent, human‑in‑the‑loop software.**

<!--
Presenter: one line — "Loom is to agentic applications what the web frameworks
were to web apps. Today I'll show you why it matters, and that it's real and working."
-->

---

## Every era gets its framework

| Era | Built around | Frameworks |
|-----|--------------|------------|
| **Web** | Pages, APIs, databases | Rails, Django, React |
| **Cloud** | Services, containers | Kubernetes, Terraform |
| **AI** | Foundation models | Copilots, model SDKs |
| **Agentic** | **Workflows · Capabilities · Agents · Generated UIs** | **← this is the gap** |

The next generation of software is **agentic**. The tooling for it doesn't exist yet.

---

## Today's frameworks assume the wrong shape

Traditional request/response:

```
Human → UI → Backend → Database
```

Agentic systems actually look like:

```
Human → Intent → Planner → Workflow → Agents → Tools
                                          ↓
                              Generated Interfaces → External Systems
```

Current frameworks bolt AI onto a request/response world. **Loom is built for the agentic shape.**

---

## Five problems every AI team hits

1. **Agent orchestration is hand‑rolled** — prompts, context, memory, retries, approvals, observability, all bespoke.
2. **No durable execution** — real processes wait for humans, approvals, and events. Request/response can't.
3. **Fragmented developer experience** — every app re‑integrates LLM SDKs + a workflow engine + a vector DB + a UI framework + observability.
4. **User interfaces are static** — most AI ends at a text box. Business needs forms, approvals, dashboards, timelines.
5. **AI costs keep rising** — systems replay conversations and re‑invoke expensive models redundantly.

---

## What Loom is

- An **application framework** for agentic systems
- A **durable, resumable execution runtime** (event‑sourced)
- A **workflow + agent runtime** with human‑in‑the‑loop built in
- A **schema‑driven UI platform** — interfaces are generated, not hand‑built
- A **multi‑agent + capability runtime** (MCP tools, agent‑to‑agent)

## What Loom is not

- Not another chatbot framework, prompt toolkit, low‑code platform, or model SDK wrapper.

---

## Core thesis

> ### Intelligence behaves like a **process**, not a **request**.

Processes **pause, wait, migrate, collaborate, and resume**.

Traditional frameworks optimize for **hydration** (rebuild state on every request).

**Loom optimizes for continuation** — a workflow can suspend for a day waiting on a human, survive a process restart, and resume exactly where it left off.

---

## Capabilities at a glance

| Capability | What it gives you |
|------------|-------------------|
| **Durable execution** | Suspend/resume across restarts; nothing is re‑run |
| **Event‑sourced state** | Every action is an auditable, replayable event |
| **Pluggable storage** | The audit log lives where you trust it — embedded SQLite, or your own Postgres / Redis / DynamoDB; no SaaS lock‑in |
| **Speculative branching** | Fork an in‑flight task, try alternate plans, keep the winner |
| **Agents + tools** | ReAct agents, MCP tool discovery, agent memory |
| **Agent‑to‑Agent (A2A)** | Expose a workflow as an agent; call remote agents |
| **Generated UI (A2UI)** | Agents drive live UIs via durable patches |
| **Intent → Plan → Capability** | Users express goals; Loom routes & plans |
| **Multi‑surface** | Same app renders to web, Angular, terminal, … |

---

## It's real — and it's working today

- **~40 packages** in a typed monorepo (durable core, agentic runtimes, pluggable compute, DX tooling)
- **Full test suite green** across every package (~180 tests)
- **Three runnable reference apps**, all offline (no API key needed):
  - **Cloud Command Center** (React) — durable incident response, streaming AI triage, human approval
  - **Angular Command Center** — the *same runtime*, different UI framework
  - **Agent Network** (headless) — LLM → agent → MCP → A2A → intent → planner → memory → terminal, end to end

*Live demo follows the deck.*

---

## Business value

**For developers**
- Far less infrastructure code · lower operational complexity · faster delivery

**For enterprises**
- Governance, auditability, compliance, explainability — the event log *is* the audit trail
- Lower operational cost — replay + memoized effects avoid redundant model calls

**For platform teams**
- Standardization · reusable **capabilities** · centralized policy & governance

---

## New: responsive & high-performance — all opt-in

Recent additions make agentic apps feel faster, without changing anything that already works:

- **Stop runaway work instantly** — long-running agent and workflow tasks can now be cancelled responsively, with a full audit record of the cancellation.
- **Snappier live UIs** — streaming AI responses and dashboards stay smooth even under heavy update volume.
- **Pluggable high-performance rendering** — the same app can drive faster, more granular UIs across web and other surfaces.

**Every improvement is opt-in and off by default — zero regression to existing behavior or cost** (verified by benchmarks).

---

## Competitive positioning

Loom is a **new category built on proven building blocks**.

| Existing category | Loom becomes |
|-------------------|--------------|
| Web framework | **Agentic framework** |
| API gateway | **Capability runtime** |
| Workflow engine | **Intelligence runtime** |
| Component library | **Blueprint runtime** |
| Service mesh | **Agent mesh** |
| Event store | **Intelligence state** |

---

## The cost & efficiency angle

Because state lives in an **append‑only event log** and effects are **memoized**:

- Resumed workflows **do not re‑run** completed steps or re‑call the model
- No replaying whole conversations to rebuild context
- Token spend tracks *new* work, not repeated work

**Event sourcing turns durability, auditability, and cost‑efficiency into the same mechanism.**

---

## Adoption path

1. **Build a flagship internally** — e.g. a cloud‑ops / database command center (already prototyped).
2. **Extract reusable primitives** — replay runtime, projection runtime, blueprint runtime, capability runtime.
3. **Open‑source the framework** — establish the category.
4. **Grow an ecosystem** — capability & agent marketplace.

Incremental and layered — teams adopt one capability at a time.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| **Large architectural scope** | Layered packages; adopt incrementally; reuse existing SDKs |
| **Market maturity may lag** | Lead with a real product; extract the framework later |
| **Agentic systems get complex** | Event sourcing + deterministic replay + built‑in observability keep them debuggable |

---

## How we'll measure success

**Technical**
- Workflow completion rate · resume latency · **token efficiency** · replay latency

**Business**
- Developer productivity · operational cost reduction · deployment frequency · customer satisfaction

---

## The ask

- Endorse a **pilot**: rebuild one real internal workflow (an ops/approval process) on Loom.
- Fund **primitive extraction** from the flagship into a shared platform.
- Nominate one **platform team** to own capabilities & governance.

**"Adopting Loom" = standardizing how we build intelligent, human‑in‑the‑loop software.**

---

<!-- _paginate: false -->

## Appendix — glossary

- **Capability** — a business action (e.g. `investigate‑incident`) exposed as an API, UI action, A2A endpoint, or workflow node.
- **Projection** — a read‑model derived by folding the event log (drives dashboards).
- **Blueprint** — a JSON‑serializable UI description rendered to any surface.
- **Effect** — a sandboxed side effect (tool/LLM/human/agent) that runs once and is remembered.
- **Resumability** — restoring a live/suspended execution without re‑running work.
- **A2UI** — Agent‑to‑UI: agents drive interfaces via durable patch events.
