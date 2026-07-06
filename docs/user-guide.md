# Loom — User Guide

A **topic-by-topic reference** with runnable examples. Unlike the sequential [Usage](usage.md) tutorial, jump to any section. For the *why* behind these designs, see [Architecture](architecture.md).

## Contents

- [1. Flows, steps & handlers](#1-flows-steps--handlers)
- [2. The WorkflowContext](#2-the-workflowcontext)
- [3. Effects & middleware](#3-effects--middleware)
- [4. Suspend & resume](#4-suspend--resume)
- [5. Branching: fork / simulate / promote](#5-branching-fork--simulate--promote)
- [6. Projections & A2UI surfaces](#6-projections--a2ui-surfaces)
- [7. Agents, tools & A2A](#7-agents-tools--a2a)
- [8. Intent, planner & memory](#8-intent-planner--memory)
- [9. Configuration reference](#9-configuration-reference)
- [10. Testing](#10-testing)
- [11. The `loom` CLI](#11-the-loom-cli)
- [12. Evals & deploy simulation](#12-evals--deploy-simulation)
- [13. Where executions run (compute)](#13-where-executions-run-compute)
- [14. Determinism rules & pitfalls](#14-determinism-rules--pitfalls)

---

## 1. Flows, steps & handlers

### `step$` — a unit of work

```ts
import { step$, handler$ } from "@loom/core";
import { z } from "zod";

const step = step$({
  id: "restart-pool",              // unique within the flow
  name: "Restart connection pool",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: handler$(async (input, ctx) => ({ ok: true })), // co-located logic
  toolId: "restart-pool",          // OR resolve to a registered Effect by id
  retry: { maxAttempts: 3 },       // optional
  timeoutMs: 30_000,               // optional
});
```

A step either carries an inline `handler` **or** names a `toolId` that resolves to an Effect registered in the `EffectRuntime` (§3). Use inline handlers for logic that lives with the flow; use `toolId` for shared or externally-provided effects.

### `flow$` + runner — a `RegisteredFlow`

The `flow$` **definition** is declarative metadata (schemas, version, the step list). The **runner** is the imperative orchestration function. A `RegisteredFlow` bundles them:

```ts
import { flow$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";

const runner: FlowRunner<In, Out> = async (ctx, input) => {
  const a = await ctx.run(stepA, { target: input.target });
  const b = await ctx.run(stepB, { from: a });
  return { result: b };
};

export const myFlow: RegisteredFlow<In, Out> = {
  definition: flow$({ id: "my-flow", name: "My Flow", version: "1.0.0", inputSchema, outputSchema, steps: [stepA, stepB] }),
  runner,
};
```

Register and run:

```ts
runtime.registerFlow(myFlow.definition, myFlow.runner);
const handle = await runtime.start(myFlow, input, { executionId: "opt-custom-id" });
```

> **Versioning.** `version` is part of the flow identity and is recorded. Deploy-sim (§12) uses the log to check whether new definitions can still resume old executions.

---

## 2. The WorkflowContext

The `ctx` passed to a runner is the only durability touch-point. Everything else is plain code.

```ts
interface WorkflowContext {
  readonly executionId: string;
  readonly workflowId: string;

  run<TIn, TOut>(step: StepDefinition<TIn, TOut>, input: TIn): Promise<TOut>;
  parallel<T extends unknown[]>(
    pairs: { [K in keyof T]: [StepDefinition<unknown, T[K]>, unknown] },
    options?: { limit?: number }
  ): Promise<T>;
  suspend(config: { on: string; timeout?: number; correlationKey?: string }): Promise<never>;
  emit(eventType: string, payload: unknown): void;
  stream(eventType: string, delta: string, done?: boolean): void;
  readonly ui: A2UIEmitter; // .set / .merge / .append
}
```

**Parallel steps**, order-preserving and concurrency-bounded:

```ts
const [metrics, logs] = await ctx.parallel(
  [ [fetchMetrics, { target }], [fetchLogs, { target }] ],
  { limit: 2 }
);
```

**Emit domain events** into the log for projections/telemetry:

```ts
ctx.emit("assessment_complete", { riskLevel: "high" });
```

**Stream** incremental output (e.g. LLM tokens) — deltas surface live but the final result is what's recorded:

```ts
ctx.stream("triage_tokens", token);        // …deltas…
ctx.stream("triage_tokens", "", true);     // done
```

---

## 3. Effects & middleware

### Effects isolate side effects

All I/O flows through the `EffectRuntime`, keyed by `toolId`. During replay, a completed effect is served from the log — **never re-executed** — which is what makes resumes and forks exactly-once.

```ts
import { EffectRuntime, ToolEffect, LlmEffect } from "@loom/effect-runtime";

runtime.register("fetch-metrics", new ToolEffect(async (input: { target: string }, ctx) => {
  return await api.metrics(input.target);
}));

runtime.register("triage-llm", new LlmEffect(async (input, ctx) => {
  ctx.emit("llm_call", { model });
  return await provider.complete(input);
}));
```

Effect kinds: `"tool" | "llm" | "human" | "a2a"`. The `EffectContext` gives handlers `executionId`, `stepId`, `attempt`, `emit()`, and an optional `signal` (AbortSignal) for cancellation.

### Middleware wraps effects

Middleware is a composable chain `(ctx, input, next) => Promise`, applied outermost-first — identical in spirit to HTTP middleware.

```ts
import { retryMiddleware } from "@loom/middleware";
import type { EffectMiddleware } from "@loom/effect-runtime";

const logging: EffectMiddleware = async (ctx, input, next) => {
  const t = performance.now();
  try { return await next(); }
  finally { console.log(`${ctx.stepId} took ${(performance.now() - t).toFixed(1)}ms`); }
};

const app = defineConfig({
  storage: { kind: "memory" },
  flows: [myFlow],
  effectMiddleware: [
    logging,
    retryMiddleware({ maxRetries: 3, baseDelayMs: 200, factor: 2, jitter: true }),
  ],
});
```

`retryMiddleware` options: `maxRetries`, `baseDelayMs`, `factor`, `maxDelayMs`, `jitter` (deterministic FNV-1a jitter — no `Math.random`), `isRetryable`, `onRetry`, and an injectable `sleep`. It **never** retries a `SuspendError` or an aborted signal.

---

## 4. Suspend & resume

`ctx.suspend()` writes a durable checkpoint and returns control to the caller. The execution now lives entirely in storage — the process can restart, and another machine can resume it.

```ts
const decision = (await ctx.suspend({
  on: "ApprovalGranted",           // logical event you'll resume with
  correlationKey: input.target,     // used to route the resume to this execution
  timeout: 24 * 60 * 60 * 1000,     // optional; drives a timeout condition
})) as { approved: boolean; approvedBy: string };
```

Resume from anywhere:

```ts
await runtime.resume(executionId, {
  eventType: "ApprovalGranted",
  payload: { approved: true, approvedBy: "operator" },
});
```

**Mechanics.** On resume the runner re-runs from the top. Every step that already completed is replayed from its logged `STEP_COMPLETED` (the effect does not run again); when execution reaches the original `suspend()`, that call *returns the resume payload* and the flow proceeds. This is deterministic replay (see [Architecture §4.3](architecture.md#43-suspend--resume)).

**Recovery.** A crash mid-flight is just a resume: on redispatch the runtime folds durable state and, if still `running`, resumes; if already terminal, returns as-is. No step re-runs. `loadState(id)` folds state without running.

**Bounding replay.** For long executions, set `snapshotEvery` so a resume folds only the tail after the latest snapshot:

```ts
new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime, snapshotEvery: 100 });
```

---

## 5. Branching: fork / simulate / promote

Branching is nearly free because state is `fold(events)` — a fork copies the event prefix into a new execution and resumes it differently. Enable it with `storage: { branching: true }` (or pass a `BranchRegistry`).

```ts
// Fork the prefix [0..sequence] into a new branch.
const fork = await runtime.fork(parentId, atSequence, { branchName: "spec/scale" });
// fork.executionId is a new, independent execution seeded at the fork point.

// Resume the branch differently (e.g. a "simulate" flag your flow reads).
const resumed = await runtime.resume(fork.executionId, {
  eventType: "RemediationDecision",
  payload: { approved: true, strategy: "scale", simulate: true },
});
const outcome = (await resumed.waitForCompletion()).variables._output;
```

The `BranchRegistry` provides git-style refs — `putRef`, `moveTip`, `promote(from, to)`, `children`, `getLineage`:

```ts
await branchRegistry.putRef({ name: "main", executionId: parentId, tip: forkPoint });
await branchRegistry.promote("commit", "main"); // pointer move, no merge
```

**Pattern (fork → simulate → compare → promote).** Fork per strategy, run concurrently with `parallelLimit`, compare the projected outcomes, then commit the winner via a fresh fork resumed with `simulate:false`. Losing branches stay immutable — a full audit trail. Full worked example: [`examples/incident-war-room`](../examples/incident-war-room) and the [Usage tutorial §10](usage.md#step-10--branch-fork--simulate--promote).

---

## 6. Projections & A2UI surfaces

A **projection** is a read model folded from events, independent of durability. Flows emit UI patches via `ctx.ui`; they fold into named **surfaces**.

```ts
ctx.ui.set("phase", "investigating");                 // overwrite path
ctx.ui.merge("metrics", { cpu: 87, memMb: 14000 });   // shallow-merge object
ctx.ui.append("timeline", "collected metrics");        // push to array (amortized O(1) in a batch)
```

Read a surface (server, client, or test):

```ts
const view = app.projectionRuntime.getState<MyView>("mission", executionId);
```

Register surfaces via `defineConfig({ surfaces: ["mission", "telemetry"] })`, or a custom projection with `projection$({ id, name, initialState, handlers })` for domain-specific read models. Render with any renderer — `@loom/renderer-react`, `@loom/renderer-terminal`, `@loom/a2ui` for Web Components, or your own. **The durable log never depends on the renderer.**

For streamed progress independent of surfaces, use a pub/sub hub (`progressHub`) — handlers call `report(id, line)` / `reportProgress(id, pct)` and orchestrators subscribe (`onReport` / `onProgress`). See [`examples/schema-migration-planner`](../examples/schema-migration-planner).

---

## 7. Agents, tools & A2A

### Tools & agents

```ts
import { tool$, agent$ } from "@loom/core";

const queryTool = tool$({
  id: "query-db", name: "Query DB", description: "Run a read-only query",
  inputSchema: z.object({ sql: z.string() }), outputSchema: z.object({ rows: z.array(z.unknown()) }),
});

const dbaAgent = agent$({
  id: "dba", name: "DBA Agent", description: "Owns database operations",
  tools: [queryTool],
});
```

`@loom/agent` runs a ReAct-style reason→act loop over an agent's tools; `@loom/mcp` discovers external tools via the Model Context Protocol.

### A2A — agent-to-agent

Expose a Loom flow as an A2A task, and call *external* agents (Google ADK, LangGraph, CrewAI) as steps. Locally, the `InProcessA2ABus` dispatches a capability to its owning agent with streaming callbacks:

```ts
const result = await app.bus.dispatch(capabilityId, input, prompt, {
  executionId: taskId,
  onProgress: (line) => report(taskId, line),
  onStatus: (status) => setStatus(taskId, status),
  onApproval: mutating ? () => gate(taskId) : undefined, // human gate for mutating steps
});
```

Register the mapping in config: `defineConfig({ agents: [card…], capabilityAgents: { "assess-cpu": "sre", … } })`. The `LoomAgentExecutor` adapts any registered flow into a stateless A2A task (folds state from stores per request) — see [ADR 0007](adr/0007-manifest-and-a2a-adapter.md).

---

## 8. Intent, planner & memory

Compose "type a goal, do the right thing":

```ts
const route = await intent.route(goal);   // @loom/intent → primary capability + rationale
const plan  = await planner.plan(goal);   // @loom/planner → ordered capability steps

for (const s of plan.steps) {
  await app.bus.dispatch(s.capabilityId, inputFor(s), prompt);
}
```

`@loom/memory` gives agents scoped, TTL/size-bounded stores via `memory$({ id, name, ttlMs, maxEntries })`. `@loom/orchestrator` packages the recurring route→plan→dispatch→gate loop as composable functions (`dispatchPlan`, `decideApproval`) — use them where they fit; drop to primitives where they don't ([ADR 0013](adr/0013-orchestrator-primitives.md)).

The full stack in action: [`examples/db-command-center`](../examples/db-command-center).

---

## 9. Configuration reference

`defineConfig(config: LoomConfig): LoomApp`.

```ts
interface LoomConfig {
  storage: { kind: "sqlite" | "memory"; dir?: string; branching?: boolean };
  surfaces?: string[];
  flows?: RegisteredFlow[];
  flowModules?: FlowModule[];          // from `loom gen` (static discovery)
  effectMiddleware?: EffectMiddleware[];
  validate?: boolean | "warn" | "error";
  agents?: AgentCard[];
  capabilityAgents?: Record<string, string>;
  telemetry?: TelemetryAdapter[];
  dispatcher?: ExecutionDispatcher;    // where executions run
  onEvent?: (event: EventEnvelope) => void;
  onWarn?: (message: string) => void;
  projectionRuntime?: ProjectionRuntime;
  catalog?: CatalogLike;
  manifest?: ManifestView;
}

interface LoomApp {
  runtime: WorkflowRuntime;
  effectRuntime: EffectRuntime;
  projectionRuntime: ProjectionRuntime;
  bus: InProcessA2ABus;
  stores: { eventStore: EventStore; snapshotStore: SnapshotStore; branchRegistry?: BranchRegistry };
  close(): Promise<void>;
}
```

`validate` runs the boot-time flow-graph check (missing effect for a step's `toolId`, dangling capability→agent) — `"warn"` logs, `"error"` throws. Same engine as `loom check` ([ADR 0012](adr/0012-flow-graph-validation.md)).

**Manual wiring** (no `defineConfig`) is fully supported — everything above is sugar over `new WorkflowRuntime({...})`, `new EffectRuntime([...middleware])`, and a projection runtime.

---

## 10. Testing

`@loom/testing`:

| Helper | Purpose |
|---|---|
| `createTestApp(config?)` | in-memory `LoomApp` (storage defaults to memory) |
| `waitFor(pred, { timeoutMs, intervalMs })` | poll until a predicate holds |
| `waitForPhase(pr, surface, id, phase)` | wait until a surface reaches a phase |
| `getSurfaceState(pr, surface, id)` | read a surface |
| `driveToSuspend(handle)` | start→first suspend |
| `resumeWith(runtime, id, event?)` | resume sugar |
| `captureGolden(eventStore, id)` | grab the event log as a fixture |
| `recordingProvider` / `replayingProvider` | VCR LLM: record once, replay deterministically |

```ts
import { createTestApp, waitForPhase, captureGolden } from "@loom/testing";

const app = createTestApp({ surfaces: ["mission"], flows: [myFlow] });
const handle = await app.runtime.start(myFlow, input);
await handle.waitForCompletion();
await waitForPhase(app.projectionRuntime, "mission", handle.executionId, "done");
const golden = await captureGolden(app.stores.eventStore, handle.executionId);
await app.close();
```

VCR keeps LLM tests offline and deterministic (lookup is O(1) by request hash):

```ts
import { recordingProvider, replayingProvider, emptyCassette } from "@loom/testing";
const cassette = emptyCassette();
const provider = process.env.RECORD ? recordingProvider(realLlm, cassette) : replayingProvider(cassette);
```

---

## 11. The `loom` CLI

```
loom gen   [--dir app]                          regenerate loom.gen.ts from app/flows
loom new   <flow|agent|tool> <name> [--dir app] scaffold a file (folder convention)
loom check --manifest <path>                    static flow-graph checks
loom logs  --db <path> <executionId>            print the event timeline
loom debug --db <path> <executionId> [--at N]   time-travel: state at sequence N
loom eval  --dir <path>                         replay golden logs vs expectations
loom deploy check --logs <dir> --config <mod>   simulate deploy vs new flow defs
loom inspect --db <path> [--port N]             web inspector (timeline + slider)
```

- **`logs` / `debug` / `inspect`** operate directly on a SQLite event DB — no app load needed. `debug --at N` folds the exact state at sequence *N* (time-travel); `inspect` serves a web timeline with a slider using the same fold.
- **`gen` / `new`** implement the folder convention via **build-time codegen** (a static `loom.gen.ts`), not runtime globbing ([ADR 0011](adr/0011-folder-convention-codegen.md)).
- **`eval` / `deploy check` / `check`** are CI gates (§12).

---

## 12. Evals & deploy simulation

Both replay the durable log — the log *is* the fixture.

**Evals** (`@loom/eval`, `loom eval`): store an execution's event log as a golden fixture (`captureGolden`) plus expectations; `loom eval --dir evals/` replays each and reports pass/fail, exiting non-zero for CI.

```jsonc
// evals/happy.json
{ "name": "happy path", "log": [ /* EventEnvelope[] */ ], "expect": { "status": "completed", "stepsCompleted": ["investigate", "apply"] } }
```

**Deploy simulation** (`@loom/deploy-sim`, `loom deploy check`): replay historical logs against your **new** flow definitions to catch resume-incompatibility *before* promoting — a removed step or missing flow is flagged breaking; a suspended carry-over is a warning. This catches what type-checking can't: whether in-flight executions can still finish after a deploy ([ADR 0008](adr/0008-evals-and-deploy-simulation.md)).

---

## 13. Where executions run (compute)

By default, `start`/`resume` run in-process. A **dispatcher** decides placement; the same flows run anywhere because an `ExecutionPackage` carries resume coordinates (identity + sequence), never code.

```mermaid
flowchart LR
  cfg["defineConfig({ dispatcher })"] --> D["ExecutionDispatcher"]
  D --> L["local (in-process)"]
  D --> R["remote (HTTP → worker-server)"]
  D --> C["Cloud Run (platform-cloudrun)"]
```

- **Local:** `@loom/worker-runtime-local` — same process.
- **Remote:** `@loom/worker-runtime-remote` posts an `ExecutionPackage` to `@loom/worker-server`'s `POST /execute`; the stateless worker rebuilds all state from shared stores.
- **Cloud Run:** `@loom/platform-cloudrun` maps dispatch metadata to sizing; see [`packages/platform-cloudrun/deploy.md`](../packages/platform-cloudrun/deploy.md).
- **Fan-out:** `@loom/graph-executor` runs graph nodes as per-node executions (one writer each), joined via lineage.

Workers reference flows/effects **by id** from a statically-wired registry — so a worker must be booted with the same registrations (P5). Suspension is a normal result across the network boundary.

---

## 14. Determinism rules & pitfalls

Determinism is what makes resume, fork, and replay trustworthy. Keep these in mind:

- **Put non-determinism inside effects, not orchestration.** Wall-clock reads, randomness, and I/O belong in a `handler`/Effect (whose result is logged), *not* in the runner's control flow. A runner must reach the same suspend/step sequence on replay.
- **Don't branch orchestration on unlogged external state.** If the runner does `if (Date.now() % 2)` it may diverge on replay. Fetch the value in a step, then branch on the step's (logged) output.
- **Effects run once; replays serve from the log.** Don't rely on a side effect happening again during resume — it won't.
- **Keep wiring static.** Register flows/effects explicitly (or via `loom gen`). No runtime globbing or env-conditional registration, or a remote worker/replay can't reconstruct the same graph (P5).
- **Middleware must be replay-safe too.** Retries/jitter use deterministic hashing, not `Math.random`. Follow suit in custom middleware on replayable paths.
- **Snapshots are an optimization, not truth.** The log is authoritative; snapshots only shorten the fold. Never store data *only* in a snapshot.

---

### See also

- **[Getting Started](getting-started.md)** · **[Usage tutorial](usage.md)** · **[Architecture](architecture.md)** · **[ADRs](adr/)**
- Runnable apps: [`examples/`](../examples) — `agent-network`, `db-command-center`, `incident-war-room`, `schema-migration-planner`.
