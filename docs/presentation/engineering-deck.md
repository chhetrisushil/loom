---
marp: true
theme: default
paginate: true
title: "Loom — Engineering Deep Dive"
---

<!-- _paginate: false -->

# Loom — Engineering Deep Dive

### Durable, event‑sourced, agentic application runtime

**TypeScript monorepo · pnpm + Turborepo · event sourcing · deterministic replay · schema‑driven UI**

<!--
Presenter: "This is the how. We'll go layer by layer, then do a live walkthrough
and demo. Everything shown here is real code you can open in the repo."
-->

---

## The pipeline

```
Intent → Planner → Workflow → Agent → Effect → Event Log
                                                    │
                                              Projection
                                                    │
                                              Blueprint → Surface (web / angular / terminal)
```

- **Left half** = intelligence (what to do): intent routing, planning, capabilities.
- **Middle** = durable execution: workflow + agent + effects, all event‑sourced.
- **Right half** = generated UI: projections fold events → blueprints render to any surface.

---

## Package map (24 packages)

**Core runtime** — `core` (builders/types), `workflow-runtime`, `effect-runtime`, `event-runtime`, `snapshot-runtime`, `replay-vm`, `projection-runtime`

**UI** — `blueprint-runtime`, `renderer-react`, `renderer-terminal`

**Agentic** — `llm`, `agent`, `mcp`, `a2a`, `a2ui`

**Intelligence** — `capability`, `intent`, `planner`, `memory`

**Tooling** — `compiler` (Vite plugin), `telemetry`, `registry`, `sdk` (public surface), `scheduler` (opt-in cooperative scheduler)

<!-- Presenter: everything is re-exported from @loom/sdk; apps import from there. -->

---

## Mental model

> ### The **event log is truth**. Everything else is a **projection**.

- Application state = an append‑only log of `EventEnvelope`s.
- UI, dashboards, read‑models = pure functions folding that log.
- Determinism + replay fall out for free: same events → same state.

This is the single idea the whole framework is built on.

---

## Developer primitives

All in `packages/core/src/builders/` — declarative `$` builders:

```ts
import { flow$, step$, handler$, tool$, agent$, skill$, instructions$, projection$, memory$, policy$ } from "@loom/core";
import { capability$ } from "@loom/capability";

const FetchMetrics = step$({
  id: "fetch-metrics",
  inputSchema, outputSchema,
  handler: handler$(async (input, ctx) => ({ cpu: 87, mem: 14000 })),
});

const flow = flow$({ id: "investigate", version: "1.0.0", inputSchema, outputSchema,
                     steps: [FetchMetrics /* … */] });
```

You define **capabilities, flows, steps, tools, projections, policies, memory** — Loom provides the rest.

---

## Execution model

```
WorkflowRuntime.start(flow, input)
   │  appends EXECUTION_STARTED, builds a ReplayVM
   ▼
runner(ctx, input)          ← your flow function
   │  ctx.run(step, input)
   ▼
EffectRuntime.execute(toolId)   → the Effect (tool / llm / human / a2a)
   │  appends STEP_STARTED / STEP_COMPLETED
   ▼
onEvent → ProjectionRuntime → UI
```

- `WorkflowRuntime` (`packages/workflow-runtime`) orchestrates; `EffectRuntime` isolates side effects; `ReplayVM` (`packages/replay-vm`) folds events → state.
- Event store + snapshot store persist everything — **async-first** interfaces, so in-memory + SQLite ship in the box and Postgres/Redis/DynamoDB plug in as first-class backends (a per-execution `ExecutionJournal` keeps `ctx.emit`/`ctx.ui` synchronous).

---

## `WorkflowContext` — the flow API

The `ctx` handed to every flow runner:

```ts
await ctx.run(step, input)          // execute a step (memoized on replay)
await ctx.parallel([[a, i], [b, j]])// run steps concurrently
await ctx.suspend({ on: "ApprovalGranted", correlationKey, timeout })
ctx.emit("DOMAIN_EVENT", payload)   // durable custom event
ctx.stream("TOKEN", delta, done)    // token streaming
ctx.ui.set("phase", "triaging")     // A2UI — drive the UI (durable patch)
```

Every call is an **event** — durable, ordered, replayable.

---

## The killer feature: durable suspend / resume

```ts
const metrics = await ctx.run(FetchMetricsStep, input);   // step 1
const logs    = await ctx.run(FetchLogsStep, input);      // step 2
await ctx.suspend({ on: "ApprovalGranted" });             // wait — maybe for days
const fix     = await ctx.run(ApplyRemediationStep, input); // step 3, after approval
```

- On suspend: snapshot saved, process can exit.
- On resume — **even in a brand‑new process** — steps 1 & 2 return **cached** outputs; only step 3 runs.
- **Proof:** `examples/cloud-command-center/test/e2e/suspend-resume.test.ts` resumes in a fresh runtime and asserts the metrics/logs effects are called **0** times.

---

## Speculative branching — fork the log, pick a winner

The same immutable-log machinery gives you git-style branching for **free**:

```ts
// A task suspended at its approval gate (sequence S). Fork it.
const branch = await runtime.fork(taskId, S, { branchName: "spec/scale-replicas" });
await runtime.resume(branch.executionId, { eventType: "ApprovalGranted", payload: { approved: true } });
branchRegistry.promote("spec/scale-replicas", "main");  // keep the winner
```

- **`fork`** copies the parent prefix `[0..S]` into a child id (COW) + a seed snapshot → identical replay, cached steps not re-run, **parent untouched**. No new event type.
- **`BranchRegistry`** (`@loom/event-runtime`): movable refs + fork lineage; **`promote` is a pointer move, not a merge**.
- **Branch-only by design** — divergent `ExecutionState`s have no principled join. **Proof/demo:** `packages/workflow-runtime/src/fork.test.ts` · `demo:fork` in `db-command-center-server`.

---

## Effects: one interface, four kinds

```ts
interface Effect<TIn, TOut> {
  kind: "tool" | "llm" | "human" | "a2a";
  execute(input: TIn, ctx: EffectContext): Promise<TOut>;
}
```

- `ToolEffect` — any async work (HTTP, DB, compute)
- `LlmEffect` — a model call (see `@loom/llm`)
- `HumanEffect` — throws `SuspendError` → human‑in‑the‑loop
- `A2AEffect` — delegate to a remote agent

Same execution + replay semantics for all four. **AI calls are just effects** — so they're durable too.

---

## Configurable LLM — `@loom/llm`

The model is chosen in exactly **one** place:

```ts
import { AnthropicProvider, createLlmEffect } from "@loom/llm";

const provider = new AnthropicProvider({ model: "claude-opus-4-8" });
// or new OpenAiProvider({ model: "gpt-4o" }) — or your own LlmProvider

effectRuntime.register("summarize", createLlmEffect({
  provider,
  buildRequest: (input) => ({ messages: [{ role: "user", content: input.text }] }),
}));
```

Providers talk to vendor HTTP APIs over `fetch` — **no SDK dependency**. Swap providers = one line.

---

## Agents — `@loom/agent`

```ts
const runner = new AgentRunner({ definition: agent$({ id, tools }), provider, effectRuntime, memory, skills });
const out = await runner.run({ prompt, memoryScope: "user-1" }, ctx);
```

- ReAct loop: reason → call tools via the `EffectRuntime` → observe → repeat.
- Emits `AGENT_TOOL_CALL` / `AGENT_COMPLETED` events (observable + replayable).
- `agentStep$(...)` drops an agent into a flow as an ordinary step.
- **Memory**: with a `memoryId` + `MemoryRuntime`, prior turns are recalled into the prompt and the answer is remembered (TTL / size bounded).
- **Skills** (`skill$` + `instructions$`): a `SkillRegistry` of progressively-disclosed expertise — the runner selects the relevant skills, emits `SKILLS_SELECTED`, and loads **only** their instructions (the compiler lazy-chunks each body, like `handler$`). Deterministic selection → replay-safe.

---

## Tools from anywhere — `@loom/mcp`

Model Context Protocol client — discover a server's tools and register them as effects automatically:

```ts
const mcp = new McpClient({ transport: "http", url: "http://localhost:9000/mcp" });
await mcp.connect();
const tools = await mcp.registerInto(effectRuntime);   // now callable by any agent

const agent = agent$({ id: "ops", name: "Ops Agent", tools });
```

One call turns an external MCP server into first‑class, replayable Loom effects.

---

## Agent‑to‑Agent — `@loom/a2a`

**Expose** a Loom flow as an agent, and **call** remote agents as effects:

```ts
// server (inbound): any flow becomes an A2A agent endpoint
// card derived from the agent$ definition; the server fills in url
const server = createA2AServer(workflowRuntime, triageFlow, toAgentCard(triageAgent));
await server.start();  // serves /.well-known/agent.json, /tasks/send, /tasks/:id

// client (outbound): register a REMOTE agent as a first-class Loom tool
const tool = await new A2APeerClient({ url }).registerInto(effectRuntime, registry);
const orchestrator = agent$({ id: "orchestrator", tools: [tool] });  // now calls it
```

Built on Node `http` + `fetch` — no framework HTTP dependency. Because A2A is an **open protocol**, the peer can be **Google ADK** (native `to_a2a`), a **LangGraph/CrewAI** shim, or another Loom service — bidirectional mesh, one contract. See `examples/a2a-mesh`.

---

## Generated UI — the A2UI protocol (`@loom/a2ui`)

Agents drive the UI with **typed, durable patches** — not ad‑hoc messages:

```ts
ctx.ui.set("phase", "triaging");
ctx.ui.merge("metrics", { cpu: 87 });
ctx.ui.append("timeline", "root cause found");   // set / merge / append / remove / increment
```

- Each call emits one `A2UI_PATCH` event → **durable & replayable**.
- `a2uiSurfaceProjection("ui")` folds patches into a projection; widgets bind with `{ projectionId: "ui", path }` — **zero renderer changes**.
- `StreamingText` widget grows live as tokens arrive. Refresh/resume rebuilds the exact screen.

---

## Capabilities Over APIs — `@loom/capability`

A **capability** = a flow + intent metadata, exposable four ways (API · UI action · A2A endpoint · workflow node):

```ts
const investigate = capability$({
  id: "investigate-incident",
  intent: "Investigate a production incident and recommend a fix",
  tags: ["incident", "sre"],
  inputSchema, flow: InvestigateIncidentFlow,
});

const catalog = new CapabilityCatalog().register(investigate);
catalog.registerInto(workflowRuntime);
await catalog.invoke(workflowRuntime, "investigate-incident", input);
```

---

## Intent Over Routes — `@loom/intent` + `@loom/planner`

Users express **goals**, not routes:

```ts
const intent = new IntentRuntime({ catalog, workflowRuntime });          // + optional provider
const handle = await intent.run("the prod db has high CPU, investigate", input);
// → routes to `investigate-incident`, starts the flow

const plan = await new PlannerRuntime({ catalog }).plan("triage then scale");
// → [{ capabilityId: "investigate-incident" }, { capabilityId: "scale-cluster" }]
```

Works **offline** (keyword matching) or with an `LlmProvider` (model routing/planning).

---

## Blueprints, projections & multi‑surface

- **Blueprint** = JSON‑serializable UI (`blueprint$`, `grid/stack/flex`, widgets like `MetricCard`, `Timeline`, `StreamingText`).
- **Projection** folds events into the state widgets bind to.
- `traverseBlueprint<TNode>` is framework‑agnostic → the *same blueprint* renders to:
  - **React** (`renderer-react`) — Cloud Command Center
  - **Angular** (`@Injectable` + signals + `NgZone`) — Angular Command Center
  - **Terminal** (`renderer-terminal`) — Agent Network dashboard

UI is a **projection**, not a source of truth.

---

## Cooperative scheduling & cancellation — `@loom/scheduler`

**Fiber principles land in the *agentic* layer** — an ephemeral cooperative scheduler, not a UI reconciler. **All opt-in, default-off, latency-safe** (no regression to sync fast paths — `docs/benchmarks.md`).

```ts
await ctx.parallel(pairs, { limit: 4 });   // order-preserving, replay-safe
new AgentRunner({ ...cfg, parallelTools: true }); // tool calls, order preserved
// priority lanes · yieldControl · parallelLimit · AbortSignal utils
```

- **Cancellation:** `handle.cancel()` aborts in-flight effects via `EffectContext.signal` / `LlmRequest.signal`, and records a durable `EXECUTION_CANCELLED` event — **live-only, so resume is unchanged**.
- Planner/intent run at **Idle** priority so interactive work stays snappy.

---

## `useFiber` — render-side capabilities (BYOR / BYOC)

On the render side we **leverage React's *own* fiber — no second reconciler**:

```tsx
<BlueprintRenderer fiber={fiber} />   // per-widget, path-granular re-render
```

- **Per-widget Suspense** for async BYOC (bring-your-own-component) widgets.
- **startTransition-deferred streaming** — token floods stay responsive.
- Projection coalescing: `new InMemoryProjectionRuntime({ coalesceNotifications: true })` + `useDeferredProjection`.
- **BYOR seam:** `traverseBlueprintAsync` + `IncrementalRenderer` — an interruptible incremental-commit traversal for future scheduler-less renderers (canvas / DOM / native).

All opt-in; existing renderers behave exactly as before.

---

## Build‑time & observability

**`@loom/compiler`** (Vite plugin + CLI)
- Extracts co‑located `handler$` bodies into lazy chunks
- Statically validates flow graphs; emits resumability metadata

**`@loom/telemetry`**
- `createTelemetryHook(adapter)` on `onEvent` → per‑step timings
- `ConsoleTelemetryAdapter`, OTel‑ready; playground **Trace tab** visualizes it

---

## Quality & tooling

- **Monorepo:** pnpm workspaces + Turborepo
- **Language:** TypeScript → CommonJS (`tsc --build`)
- **Tests:** Vitest — **green across every package** (~180 tests)
- **Lint/format:** Biome
- **Commands:** `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm dev`

<!-- Presenter caveat: `vite dev` for the browser examples; `vite build` (prod bundle) has a known Rollup CJS interop issue, unrelated to the framework. -->

---

## Adopt it in your codebase

Recommended repository layout:

```
agents/  flows/  steps/  tools/  projections/  capabilities/  policies/  memory/
```

- Import everything from **`@loom/sdk`**.
- Start with **one flow** (an approval/ops process) → add a **blueprint** → expose it as a **capability** → route by **intent**.

**Docs:** `docs/architecture.md` · `docs/api-reference.org` · `docs/usage.md`

---

<!-- _paginate: false -->

# Live walkthrough & demo

`code-walkthrough.md` (annotated tour) · `demo-script.md` (runbook)

**Start here:** `pnpm --filter @loom/agent-network start`
· interop: `pnpm --filter @loom/a2a-mesh start`
