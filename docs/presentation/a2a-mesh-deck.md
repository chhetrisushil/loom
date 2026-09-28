---
marp: true
theme: default
paginate: true
title: "Loom — A2A Mesh: interop with ADK / LangGraph / CrewAI"
---

<!-- _paginate: false -->

# A2A Mesh

### Using external agent frameworks *with* Loom — as bidirectional peers over A2A

**Google ADK · LangGraph · CrewAI · another Loom service — one open wire contract**

`examples/a2a-mesh` — headless Node, fully offline

<!--
Presenter: "The question we get most: 'do I have to rewrite my ADK / LangGraph
agents in Loom?' No. A2A is an open protocol — Loom already speaks it. This
example shows both directions of the mesh running offline against a mock peer,
and the README shows how to point it at a real ADK or LangGraph endpoint."
-->

---

## The problem

You already have agents — in **Google ADK** (Python/Java), **LangGraph** (Python), **CrewAI**. Loom is **TypeScript**.

You don't want to rewrite them. You want them to **work together**.

> Loom is TS; ADK/LangGraph are their own runtimes. In-process imports won't cross that line — but a **network contract** will.

**The seam is A2A** — an open agent-to-agent protocol, not a Loom-specific one. Every framework becomes "an endpoint that answers three routes."

---

## A2A in one slide

An A2A agent is any HTTP endpoint answering three routes:

```
GET  /.well-known/agent.json   # discovery — the AgentCard (name, skills, …)
POST /tasks/send               # submit a task → { id }, or the finished task for a synchronous peer
GET  /tasks/:id                # poll → { status, artifacts }
```

- **Google ADK** emits exactly this natively: `to_a2a(root_agent)`.
- **LangGraph / CrewAI** sit behind a ~40-line A2A shim over `graph.invoke(...)`.
- **Loom** already speaks it: `createA2AServer` (serve) + `createA2AClientEffect` (call).

One contract ⇒ the Loom-side code is **identical** for every peer.

---

## Bidirectional — two roles, both already in `@loom/plugin-a2a`

```
          ┌──────────────────────────── A2A (HTTP/JSON) ───────────────────────────┐
          │                                                                          │
   ┌──────▼───────┐   outbound: A2APeerClient.registerInto        ┌─────────────────▼─────┐
   │  Loom agent  │ ───────── remote agent as a Loom tool ───────▶ │  External agent       │
   │ (TypeScript) │                                                │  ADK / LangGraph /    │
   │              │ ◀──────── Loom flow as an A2A endpoint ──────── │  CrewAI / Loom peer   │
   └──────────────┘   inbound: createA2AServer + toAgentCard       └───────────────────────┘
```

- **Inbound** (external → Loom): `createA2AServer` — nothing new needed.
- **Outbound** (Loom → external): `A2APeerClient` — the **new** piece.

---

## Outbound — the missing piece: `A2APeerClient`

The A2A analogue of `McpClient.registerInto`. Discover a remote agent, register it as a **first-class Loom tool**:

```ts
import { A2APeerClient } from "@loom/plugin-a2a";

const peer = new A2APeerClient({ url: "http://localhost:8001" }); // any A2A endpoint
const tool = await peer.registerInto(effectRuntime, registry);    // kind: "a2a"

// The remote agent is now a normal tool in a local agent's toolbox.
const orchestrator = agent$({ id: "orchestrator", name: "Orchestrator", tools: [tool] });
```

- `discover()` reads `/.well-known/agent.json`; skills become the tool description the LLM sees.
- Adapts `{ prompt } → A2ATask` and `A2ATaskResult → { content }`.
- Task id derived from `executionId:stepId` → **replay-deterministic**.
- Optional `registry` also exposes the peer to the **planner / intent** layer.

---

## Inbound — expose a Loom agent to the world

Any A2A client — ADK, a LangGraph shim, or another Loom service — can drive a Loom flow:

```ts
import { createA2AServer, toAgentCard } from "@loom/plugin-a2a";

// card derived from the agent$ definition; server fills in url from its address
const server = createA2AServer(workflowRuntime, remediateFlow, toAgentCard(remediationAgent));
await server.start();  // serves /.well-known/agent.json, /tasks/send, /tasks/:id
```

- Built on Node `http` + `fetch` — no framework HTTP dependency.
- The card is a **single source of truth**: `toAgentCard(agent)` derives it from the `agent$` definition, not a parallel object.

---

## What the demo runs (offline)

`src/mockExternalAgent.ts` — a ~40-line HTTP server standing in for an ADK/LangGraph agent, so the demo needs **no Python and no network**.

```
Outbound — Loom agent calls the external peer as a tool
  Registered remote peer as tool "remote-diagnostics" (kind: a2a).
  Remote agent replied:
    Diagnosis for "prod-postgres at 92% CPU…": connection-pool exhaustion. …
  Loom agent's final answer:
    The remote agent diagnosed connection-pool exhaustion. Recycling the pool…

Inbound — external client drives a Loom agent over A2A
  Loom agent card served at http://localhost:51237/.well-known/agent.json
  Inbound A2A task status: completed
  Loom replied: { "reply": "Loom remediation … incident resolved." }
```

Both directions, one run. A Loom agent **delegates diagnosis mid-ReAct-loop** to the remote peer.

---

## Pointing at a real framework — Loom code unchanged

**Google ADK** (native A2A):

```python
from google.adk.a2a import to_a2a
a2a_app = to_a2a(root_agent)   # serve with uvicorn — exposes the 3 A2A routes
```

Loom side: `new A2APeerClient({ url: "http://localhost:8001" })`. That's it.

**LangGraph / CrewAI** (thin shim): wrap the compiled graph in a small A2A HTTP server whose `/tasks/send` calls `graph.invoke(...)` and returns the result as an artifact. Same three routes ⇒ **identical** Loom code.

**Model-only?** If you only want ADK/LangChain's *LLM* (not the agent loop), skip A2A and implement `LlmProvider` instead — cheaper.

---

## File map

```
src/
  mockExternalAgent.ts   ~40-line A2A server — stands in for ADK/LangGraph/CrewAI
  main.ts                the mesh, end to end: outbound peer call + inbound loopback
  stores.ts              in-memory Event/Snapshot stores (zero external services)
README.md                the reusable recipe + real ADK / LangGraph wiring
```

Reuses, unchanged: `createA2AClientEffect`, `createA2AServer`, `toAgentCard`,
`AgentRegistry`, and the `EffectContext.signal` cancellation seam.

---

## Run it

```bash
pnpm --filter @loom/a2a-mesh start
```

Prints both directions of the mesh and exits — no API key, no external services.

**Verified:** `@loom/plugin-a2a` builds clean; `A2APeerClient.test.ts` covers discovery,
registration, a real in-process A2A round-trip, the registry hook, and `toolId`
override (12/12 tests green). The example typechecks and runs end to end.

---

## Takeaways

- **Don't rewrite** your ADK / LangGraph / CrewAI agents — **peer with them** over A2A.
- **A2A is the one bus.** Inbound was already there (`createA2AServer`); `A2APeerClient` completes the outbound half — the `McpClient.registerInto` pattern, applied to agents.
- A remote agent becomes a **first-class Loom tool** — usable by an agent, a step, or the planner — while staying in its own runtime.
- Same code for a mock peer, a real ADK server, or another Loom service. **One contract, any framework.**

> See also: `engineering-deck.md` (the `@loom/plugin-a2a` slide) and `agent-network-deck.md` (A2A inside the full pipeline).
