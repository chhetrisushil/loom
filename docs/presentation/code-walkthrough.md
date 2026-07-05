# Loom — Annotated Code Walkthrough

A read‑along tour of real files. Open each path as you go. The **Cloud Command Center**
(`examples/cloud-command-center`) is the spine — it exercises the most — then **Agent Network**
(`examples/agent-network`) for the agentic pieces, and **Angular** for framework‑agnosticism.

> Every excerpt below is copied from the repo. Line numbers drift as code evolves; open the file to follow along.

---

## 1. A flow — durable orchestration + generated UI

**`examples/cloud-command-center/src/flows/InvestigateIncident.ts`**

```ts
export const investigateIncidentRunner: FlowRunner<InvestigateInput, InvestigateOutput> =
  async (ctx, input) => {
    ctx.ui.set("phase", "investigating");                       // A2UI patch → live UI

    const metrics = await ctx.run(FetchMetricsStep, { incidentId: input.incidentId });
    const logs    = await ctx.run(FetchLogsStep,    { incidentId: input.incidentId });

    ctx.ui.set("phase", "triaging");
    const triage  = await ctx.run(AiTriageStep, { metrics, logs });   // LLM step, streams to UI

    ctx.ui.set("phase", "awaiting-approval");
    ctx.emit("APPROVAL_REQUESTED", { incidentId: input.incidentId, aiAnalysis: triage.analysis });

    await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.incidentId,
                        timeout: 24 * 60 * 60 * 1000 });            // wait — possibly for days

    ctx.ui.set("phase", "remediating");
    const remediation = await ctx.run(ApplyRemediationStep, { incidentId: input.incidentId });

    ctx.ui.set("phase", "resolved");
    return { resolved: remediation.success, summary: remediation.summary };
  };
```

**Why it matters**
- Reads like a plain async function — but every `ctx.run` / `ctx.emit` / `ctx.ui` / `ctx.suspend` is a **durable event**.
- `ctx.suspend` parks the workflow (a snapshot is saved); it can wait 24h and survive restarts.
- `ctx.ui.set(...)` drives the UI from the flow with **no bespoke event or projection wiring** (that's A2UI).

---

## 2. Steps + co‑located handlers

**`examples/cloud-command-center/src/tools/MetricsTool.ts`**

```ts
export const FetchMetricsStep = step$({
  id: "fetch-metrics",
  toolId: "metrics-tool",
  inputSchema, outputSchema,
  handler: handler$(async (_input, _ctx) => ({          // implementation co-located
    cpu: { current: 87, threshold: 80 },
    memory: { usedMb: 14_000, totalMb: 16_000 },
    connections: { active: 450, max: 500 },
  })),
});
```

**`examples/cloud-command-center/src/tools/AiTriageTool.ts`** — a step with **no** handler:

```ts
export const AiTriageStep = step$({
  id: "ai-triage",
  toolId: "ai-triage-tool",           // effect is registered at wiring time (needs the LLM provider)
  inputSchema: z.object({ metrics: z.unknown(), logs: z.unknown() }),
  outputSchema: z.object({ analysis: z.string() }),
});
```

**Why it matters**
- `handler$` **co‑locates** the implementation with the step; the compiler can extract it into a lazy chunk. `registerFlow` auto‑registers it as a `LazyEffect`.
- When an effect needs injected config (like an LLM provider), you **omit** the handler and register the effect at runtime (next section). Same step API either way.

---

## 3. The LLM effect + A2UI streaming

**`examples/cloud-command-center/src/runtime/aiTriage.ts`** (browser‑safe — no SQLite imports)

```ts
export const llmProvider: LlmProvider = new MockLlmProvider();
//  ↑ swap for: new AnthropicProvider({ model: "claude-opus-4-8" })  — one line, nothing else changes

export function registerAiTriageEffect(effectRuntime, provider = llmProvider) {
  effectRuntime.register("ai-triage-tool", new LlmEffect(async (input, ctx) => {
    const ui = createA2UIEmitter((type, payload) => ctx.emit(type, payload));  // effect drives the UI
    let analysis = "";
    ui.set("aiStreaming", true);
    for await (const chunk of provider.stream(request)) {   // token-by-token
      analysis += chunk.delta;
      ui.set("aiAnalysis", analysis);                       // A2UI patch per token → UI grows live
    }
    ui.set("aiStreaming", false);
    return { analysis };                                    // memoized on the step frame
  }));
}
```

**Why it matters**
- **Configurable LLM:** the provider is the only place the model is named. `MockLlmProvider` keeps the demo offline; `AnthropicProvider`/`OpenAiProvider` go live with a one‑line swap.
- **A2UI streaming:** any effect that can `emit` can drive the UI. Tokens stream into the `ui` surface as durable patches, and the final text is returned so the step is **memoized on resume** (streams once, not on replay).

---

## 4. The blueprint — UI as data

**`examples/cloud-command-center/src/blueprints/IncidentBlueprint.ts`**

```ts
export const IncidentBlueprint = blueprint$({
  id: "incident-investigation",
  title: "Incident Investigation",
  layout: stack({ gap: 16, children: [
    StatusBadge({ title: "Workflow Phase", binding: { projectionId: "ui", path: "phase" } }),
    grid({ columns: 2, children: [
      MetricCard({ title: "CPU Usage %", binding: { projectionId: "metrics", path: "cpu.current" }, unit: "%" }),
      Timeline({ title: "Event Timeline", binding: { projectionId: "incident", path: "timeline" } }),
      ApprovalCard({ title: "Approve Remediation", binding: { projectionId: "incident", path: "pendingApproval" } }),
    ]}),
    StreamingText({ title: "AI Root-Cause Analysis", binding: { projectionId: "ui", path: "aiAnalysis" } }),
  ]}),
  projections: ["metrics", "incident", "ui"],
});
```

**Why it matters**
- The UI is a **JSON‑serializable description**, not React code — it's portable, cacheable, versionable, and renders to any surface.
- Widgets bind to state by `{ projectionId, path }`. The `ui` bindings read the A2UI surface; `metrics`/`incident` read event‑folded projections. `StreamingText` re‑renders as `ui.aiAnalysis` grows.

---

## 5. Projections + the A2UI surface

**`examples/cloud-command-center/src/projections/MetricsProjection.ts`** — fold events into a read‑model:

```ts
export const MetricsProjection = {
  id: "metrics",
  initialState: { cpu: { current: 0 }, /* … */ },
  handlers: {
    STEP_COMPLETED: (state, event) => {
      const { stepId, output } = event.payload;
      return stepId === "fetch-metrics" ? { ...output, lastUpdated: event.timestamp } : state;
    },
  },
};
```

The A2UI surface is **also just a projection**, provided for you:

```ts
import { a2uiSurfaceProjection } from "@loom/a2ui";
projectionRuntime.register(a2uiSurfaceProjection("ui"));   // folds A2UI_PATCH events → "ui" state
```

**Why it matters** — dashboards, forms, and the A2UI surface are all the **same primitive**: a pure fold over the event log. Nothing mutates UI state directly.

---

## 6. Runtime wiring (browser entry)

**`examples/cloud-command-center/src/main.tsx`**

```ts
const effectRuntime = new EffectRuntime();
const projectionRuntime = new InMemoryProjectionRuntime();
projectionRuntime.register(MetricsProjection);
projectionRuntime.register(IncidentProjection);
projectionRuntime.register(a2uiSurfaceProjection("ui"));            // A2UI surface

const workflowRuntime = new WorkflowRuntime({
  eventStore: new InMemoryEventStore(),
  snapshotStore: new InMemorySnapshotStore(),
  effectRuntime,
  onEvent: (e) => projectionRuntime.handleEvent(e),                 // events → projections
});

workflowRuntime.registerFlow(InvestigateIncidentFlow.definition, InvestigateIncidentFlow.runner);
registerAiTriageEffect(effectRuntime);                              // the LLM effect (needs a provider)
```

**Why it matters** — the whole runtime is a handful of composable pieces. `handler$` steps auto‑register; the AI‑triage effect is registered explicitly because it needs the provider injected. `onEvent` is the one wire from execution → UI.

---

## 7. Capabilities + Intent routing (Intent Over Routes)

**`examples/cloud-command-center/src/capabilities.ts`**

```ts
export const InvestigateCapability = capability$({
  id: "investigate-incident",
  intent: "Investigate a production database incident (high CPU, memory, connections) and remediate it after approval",
  tags: ["incident", "investigate", "cpu", "database", "postgres", "remediate"],
  inputSchema: z.object({ incidentId: z.string() }),
  flow: InvestigateIncidentFlow,
});
export const incidentCatalog = new CapabilityCatalog().register(InvestigateCapability);
```

**`examples/cloud-command-center/src/App.tsx`** — the UI routes by intent, not by button‑to‑flow:

```ts
const intent = useMemo(() => new IntentRuntime({ catalog: incidentCatalog, workflowRuntime }), [workflowRuntime]);

const startInvestigation = useCallback(async () => {
  const route  = await intent.route(intentText);                    // "high CPU…" → investigate-incident
  addLog(`Intent "${intentText}" → capability ${route?.capability.id}`);
  const handle = await intent.run(intentText, { incidentId: "cpu-001" });   // route + start
  handle.waitForSuspend().then(() => setPhase("suspended"));
}, [intent, intentText]);
```

**Why it matters** — the user types a **goal**; the Intent Runtime picks the capability and starts it. No route table, no switch statement. Offline keyword routing here; pass an `LlmProvider` for model routing.

---

## 8. The agentic showcase (headless, offline)

**`examples/agent-network/src/main.ts`** — eight numbered sections, fully runnable with `pnpm --filter @loom/agent-network start`:

```ts
// 1. Configurable LLM — ScriptedLlmProvider (swap for AnthropicProvider)
// 3. MCP — discover tools from an (in-process) MCP server
const mcpDefs = await mcpClient.registerInto(effectRuntime);
// 2. Agent — ReAct loop over the discovered tools, with on-demand skills
const runner  = new AgentRunner({ definition: opsAgent, provider, effectRuntime, skills });
// 4. A2A — expose a flow as an agent (card derived from agent$), then call it as a client
const server  = createA2AServer(serverRuntime, triageFlow, toAgentCard(triageAgent));
const a2a     = createA2AClientEffect(server.url);
// 5. Capabilities + Intent — route NL request → capability → run
const route   = await intent.route("the prod-postgres database has high CPU, please investigate");
// 6. Planner — goal → ordered plan
const plan    = await planner.plan("investigate the incident then scale the cluster");
// 7. Memory — agent recalls prior turns across a scope
// 8. Terminal surface — render the same blueprint to the terminal
console.log(new TerminalRenderer(projectionRuntime).render(incidentBlueprint, handle.executionId));
```

Supporting files worth opening: `src/capabilities.ts` (capability$ + blueprint), `src/fakeMcpServer.ts` (in‑process MCP server), `src/ScriptedLlmProvider.ts` (deterministic provider).

**Why it matters** — every agentic runtime, demonstrated end‑to‑end, offline, in one readable script.

---

## 9. Multi‑surface — one blueprint, many renderers

**Terminal** (`packages/renderer-terminal`), used in Agent Network:

```ts
import { TerminalRenderer } from "@loom/renderer-terminal";
console.log(new TerminalRenderer(projectionRuntime).render(incidentBlueprint, executionId));
// or: renderBlueprintToString(blueprint, stateMap)
```

**Angular** (`examples/angular-command-center/src/app/loom.service.ts`) — same runtime, Angular idioms:

```ts
@Injectable({ providedIn: "root" })
export class LoomService {
  readonly phase = signal<Phase>("idle");            // Angular signals ≈ React state
  constructor(private zone: NgZone) { /* zone.run() bridges Loom callbacks → change detection */ }
}
```

**Why it matters** — `WorkflowRuntime`, `ProjectionRuntime`, and the blueprints carry **zero framework imports**. `traverseBlueprint<TNode>` walks one tree for React, Angular, or a terminal string. The flow + blueprint are identical across surfaces.

---

## 10. Durability, proven

**`examples/cloud-command-center/test/e2e/suspend-resume.test.ts`**

```ts
// phase 1: run to suspend in runtime #1, then close the event store (simulate a restart)
const handle1 = await runtime1.workflowRuntime.start(InvestigateIncidentFlow, { incidentId });
await handle1.waitForSuspend();
runtime1.eventStore.close();

// phase 2: a brand-new runtime resumes the same execution id
const handle2 = await runtime2.workflowRuntime.resume(executionId,
  { eventType: "ApprovalGranted", payload: { approved: true } });
await handle2.waitForCompletion();

expect(metricsSpy2).toHaveBeenCalledTimes(0);   // steps 1 & 2 NOT re-run
expect(logsSpy2).toHaveBeenCalledTimes(0);
expect(remediationSpy2).toHaveBeenCalledTimes(1); // only the post-approval step runs
```

**Why it matters** — this is the whole thesis as an assertion: a workflow resumes in a **different process**, re‑runs **nothing** that already completed, and finishes. Continuation, not hydration.

---

## Where to go next

- **Run it:** `docs/presentation/demo-script.md`
- **Reference:** `docs/api-reference.org` · **Architecture:** `docs/architecture.org` · **Guide:** `docs/usage-framework.org`
