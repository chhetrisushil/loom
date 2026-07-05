---
marp: true
theme: default
paginate: true
title: "Loom — Agent Network: the full agentic pipeline, headless"
---

<!-- _paginate: false -->

# Agent Network

### The whole Loom agentic pipeline — end to end, headless, offline

**Configurable LLM · ReAct agent · MCP tools · A2A · capabilities + intent · planner · memory · terminal surface**

`examples/agent-network` — Node script, ~250 lines, no API key

<!--
Presenter: "This is the best opener. One `pnpm start`, no browser, no key. It
walks through every layer of Loom's agentic stack in sequence and prints a
labelled banner for each. If the leadership deck is the 'why', this is the 'it
actually all runs, watch'."
-->

---

## What it is

A single headless script (`src/main.ts`) that exercises **eight** Loom layers in order and prints a labelled banner for each — fully offline, fully deterministic.

> `pnpm --filter @loom/agent-network start` → the entire pipeline scrolls past in your terminal.

No UI, no API key, no external services: a **ScriptedLlmProvider**, an **in-process MCP server**, and **in-memory stores** make every run reproducible.

The point: the same primitives your production app uses, with nothing hidden behind a framework or a network.

---

## The eight layers

| # | Layer | Key symbol |
|---|---|---|
| 1 | Configurable LLM | `ScriptedLlmProvider` → swap for `AnthropicProvider` |
| 2 | Bring-your-own agent (ReAct) | `agent$()` + `AgentRunner` |
| 3 | MCP tool discovery | `McpClient.registerInto()` |
| 4 | A2A server + client | `createA2AServer` + `createA2AClientEffect` |
| 5 | Capabilities + Intent routing | `CapabilityCatalog` + `IntentRuntime` |
| 6 | Planner (goal → plan) | `PlannerRuntime` |
| 7 | Agent memory (recall) | `MemoryRuntime` |
| 8 | Multi-surface render | `TerminalRenderer` |

Each is a few lines; together they are the intelligence pipeline.

---

## 1. Configurable LLM — the only integration point

The model is chosen in exactly one place. Everything downstream is provider-agnostic.

```ts
// Deterministic offline — the demo is reproducible.
const provider = new ScriptedLlmProvider([
  { content: "I'll consult the runbook…",
    toolCalls: [{ id: "c1", name: "kb-lookup", input: { topic: "database CPU spike" } }],
    stopReason: "tool_use" },
  { content: "Per runbook RB-204, restart the pod and scale the pool.", stopReason: "end_turn" },
]);
```

**Go live with one line:**

```ts
const provider = new AnthropicProvider({ model: "claude-opus-4-8" });
```

---

## 3. MCP tool discovery — external tools as effects

One call turns an MCP server's tools into first-class, replayable Loom effects:

```ts
const mcpClient = new McpClient({ transport: "http", url: mcp.url });
await mcpClient.connect();
const mcpDefs = await mcpClient.registerInto(effectRuntime);   // ← tools become effects
// Discovered 1 MCP tool(s): kb-lookup
```

- `registerInto` maps each MCP tool → a `ToolEffect` in the `EffectRuntime`.
- The agent then calls them by name like any other tool.
- (Same shape as A2A's `A2APeerClient.registerInto` — one pattern, two protocols.)

---

## 2. Bring-your-own agent — a real ReAct loop

`agent$` defines the agent; `AgentRunner` runs the reason → tool-call → reason loop over your tools, with progressively-disclosed **skills**:

```ts
const opsAgent = agent$({ id: "ops-agent", name: "Ops Triage Agent",
  tools: mcpDefs, version: "1.0.0", skills: [{ id: "triage", name: "Incident Triage" }] });

const runner = new AgentRunner({ definition: opsAgent, provider, effectRuntime, skills });
const out = await runner.run({ prompt: "DB at 87% CPU, connections exhausted. What do I do?" }, ctx);
// Skills loaded on demand: cpu-saturation-runbook
// Agent used 1 tool call(s) over 2 iteration(s).
```

Skill instruction bodies load **only when selected** — deterministic selection keeps replay exact.

---

## 4. A2A — expose a flow, call it back

Any flow becomes an agent endpoint; calling a remote agent is just another effect:

```ts
const server = createA2AServer(serverRuntime, triageFlow, toAgentCard(triageAgent), { port: 0 });
await server.start();   // /.well-known/agent.json · /tasks/send · /tasks/:id

const a2aEffect = createA2AClientEffect(server.url, { pollIntervalMs: 50 });
const result = await a2aEffect.execute(
  { id: "task-1", message: { role: "user", parts: [{ type: "text", text: "DB at 87% CPU" }] } }, ctx);
// A2A task status: completed
```

> Want to call **ADK / LangGraph / CrewAI** here instead? Register them with `A2APeerClient` — see `a2a-mesh-deck.md`.

---

## 5–6. Intent routing + Planner — goals, not routes

**Capabilities** wrap flows with intent metadata; the **Intent Runtime** routes plain English to one, and the **Planner** composes an ordered multi-step plan:

```ts
const catalog = new CapabilityCatalog().register(investigateCapability).register(scaleCapability);

const intent = new IntentRuntime({ catalog, workflowRuntime: appRuntime });
const route = await intent.route("the prod-postgres database has high CPU, please investigate");
// Routed to capability: investigate-incident

const plan = await planner.plan("investigate the incident then scale the cluster");
// 1. investigate-incident   2. scale-cluster
```

No routes, no switch statements — the **catalog is the vocabulary** both runtimes reason over.

---

## 7–8. Memory + multi-surface render

**Agent memory** — scoped, durable recall across turns:

```ts
await chatRunner.run({ prompt: "My cluster is prod-postgres", memoryScope: "user-1" }, ctx);
const recalled = await chatRunner.run({ prompt: "Which cluster did I mention?", memoryScope: "user-1" }, ctx);
// Second-turn answer (with recall): Your cluster is prod-postgres.
```

**Terminal surface** — the same `blueprint$` that drives a browser UI, rendered to the terminal:

```ts
console.log(new TerminalRenderer(projectionRuntime).render(incidentBlueprint, handle.executionId));
```

One blueprint, many surfaces — the runtime is UI-agnostic all the way down.

---

## File map

```
src/
  main.ts                 orchestrates all 8 sections; section() prints the banners
  ScriptedLlmProvider.ts  deterministic offline LlmProvider (swap for AnthropicProvider)
  capabilities.ts         investigate + scale flows/capabilities + incidentBlueprint
  fakeMcpServer.ts        in-process MCP server exposing one "kb-lookup" tool
  stores.ts               in-memory Event/Snapshot stores — zero external services
```

Everything the eight layers touch is here — nothing hidden.

---

## Run it

```bash
pnpm --filter @loom/agent-network start
```

Prints a labelled banner per layer and exits — reproducible every run.

```
──────── 2. Agent ReAct loop (LLM + MCP tools) ────────
Skills loaded on demand: cpu-saturation-runbook
Agent used 1 tool call(s) over 2 iteration(s).
──────── Done — full agentic pipeline demonstrated offline. ────────
```

Offline by default (`ScriptedLlmProvider`, `fakeMcpServer`, in-memory stores);
one line swaps in `AnthropicProvider({ model: "claude-opus-4-8" })`.

---

## Takeaways

- **One script, the whole stack** — LLM, agent, tools, A2A, intent, planner, memory, render — all real primitives.
- **Dependency injection everywhere**: provider, stores, transports are swapped by *configuration*, not rewrites.
- **Offline and deterministic** ⇒ the ideal opener and a regression-safe reference.
- The same pieces power the UI examples — this is just the pipeline with the surface stripped away.

> Next: give it a UI → `cloud-command-center-deck.md`, or the multi-agent app → `db-command-center-deck.md`.
