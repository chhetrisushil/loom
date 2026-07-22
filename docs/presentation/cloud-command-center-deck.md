---
marp: true
theme: default
paginate: true
title: "Loom — Cloud Command Center"
---

<!-- _paginate: false -->

# Cloud Command Center

### An event-sourced, durable, human-in-the-loop AI incident workflow — in the browser

**Intent routing · streaming AI triage · durable suspend/approve/resume · agent surfaces · React renderer**

`examples/cloud-command-center` — React + Vite

<!--
Presenter: "This is the flagship UI demo. A cloud incident comes in; Loom fetches
metrics, streams an AI root-cause analysis live into the UI, then SUSPENDS for a
human to approve remediation — surviving a page refresh — and resumes without
re-running any completed work. Fully offline, no API key."
-->

---

## What it is

An incident-response console. State a goal, watch Loom work, approve the fix.

> "Investigate high CPU on the postgres cluster."

1. **Investigate** — fetch metrics (CPU 87%, 450/500 connections) and error logs.
2. **Triage** — an LLM **streams** a root-cause analysis into the UI, token by token.
3. **Await approval** — the workflow **suspends** at a durable checkpoint.
4. **Approve** — a human clicks *Approve*; the workflow **resumes** and remediates.
5. **Resolved** — badge flips to `resolved`; the timeline shows every transition.

The whole thing runs **in the browser**, durably — refresh mid-incident and it resumes.

---

## The entire workflow is one runner

`flows/InvestigateIncident.ts` — 28 lines, and the `ctx.suspend` is the human gate:

```ts
ctx.ui.set("phase", "investigating");
const metrics = await ctx.run(FetchMetricsStep, { incidentId });
const logs    = await ctx.run(FetchLogsStep,    { incidentId });

ctx.ui.set("phase", "triaging");
const triage  = await ctx.run(AiTriageStep, { metrics, logs });   // streams to UI

ctx.ui.set("phase", "awaiting-approval");
await ctx.suspend({ on: "ApprovalGranted", correlationKey: incidentId,
                    timeout: 24 * 60 * 60 * 1000 });               // ← durable pause
ctx.ui.set("phase", "remediating");
const remediation = await ctx.run(ApplyRemediationStep, { incidentId });
ctx.ui.set("phase", "resolved");
```

Every `ctx.run` is a checkpoint; `ctx.suspend` persists and waits — **restart-safe**.

---

## Durable suspend/resume — the core trick

The flow parks at `ctx.suspend`. A human decision **resumes it from the event log**:

```ts
// App.tsx — Approve button
const handle = await workflowRuntime.resume(executionId, {
  eventType: "ApprovalGranted",
  payload: { approved: true, approvedBy: "operator" },
});
await handle.waitForCompletion();   // remediation runs, then "resolved"
```

- The wait can be **24 hours** or a **page refresh** — state lives in the event log, not memory.
- On resume, completed steps are **replayed from the snapshot**, not re-executed.

<!-- Presenter: the e2e test proves this — see next-to-last slide. -->

---

## Proof it's durable, not just paused

`test/e2e/suspend-resume.test.ts` — the assertion that matters:

- **Phase 1:** run until suspend → `metricsSpy` and `logsSpy` each called **once**.
- **Phase 2:** resume in a **fresh runtime instance** →
  - neither spy is called **again** (steps replayed from snapshot),
  - only the **remediation** step executes.

> Resumability is the same mechanism as event sourcing — *continuation, not hydration*. A new process picks up exactly where the old one parked.

---

## Streaming AI triage → the UI, live

The triage effect streams tokens and folds each into an **agent-surface patch**:

```ts
// runtime/aiTriage.ts
const ui = createSurfaceEmitter((type, payload) => ctx.emit(type, payload));
ui.set("aiAnalysis", ""); ui.set("aiStreaming", true);

for await (const chunk of provider.stream(request)) {
  analysis += chunk.delta;
  ui.set("aiAnalysis", analysis);   // one patch per token
}
ui.set("aiStreaming", false);
```

The widget binds to that slice and grows as tokens arrive:

```ts
StreamingText({ title: "AI Root-Cause Analysis",
  binding: { projectionId: "ui", path: "aiAnalysis" } })
```

Each patch is a durable `SURFACE_PATCH` event ⇒ the streamed analysis **replays** too.

---

## Intent in, workflow out — no routes

The user's plain-English goal is routed to a capability by the **Intent Runtime**:

```ts
// App.tsx
const intent = new IntentRuntime({ catalog: incidentCatalog, workflowRuntime });
const handle = await intent.run("investigate high CPU on postgres", { incidentId });
```

- `InvestigateCapability` wraps the durable flow with intent metadata (`capabilities.ts`).
- No `switch`, no route table — the **catalog is the vocabulary** intent reasons over.
- Same routing primitive as `agent-network` and `db-command-center`.

---

## Event sourcing → projections → widgets

State is an **append-only event log**; read models are **projections**; the UI **binds to projection slices**:

```
 events         projections (read models)        blueprint widgets (React)
 ───────        ─────────────────────────        ─────────────────────────
 STEP_COMPLETED ─▶ MetricsProjection   ─────────▶ MetricCard { path: "cpu" }
 APPROVAL_…     ─▶ IncidentProjection  ─────────▶ Timeline, StatusBadge
 SURFACE_PATCH     ─▶ "ui" surface        ─────────▶ StreamingText { path: "aiAnalysis" }
```

`<BlueprintRenderer blueprint={IncidentBlueprint} projectionRuntime={…} executionId={…} />`
renders it — a refresh or resume rebuilds the **exact** screen from the log.

---

## Same durable backend, swap the renderer → Angular

The identical flow, steps, `ctx.suspend`, event log, and projections run under **Angular** with **zero React** — `examples/angular-command-center`. Only the render layer changes.

| Layer | React — `cloud-command-center` | Angular — `angular-command-center` |
|---|---|---|
| Durable backend | `@loom/core` · `workflow-runtime` · `projection-runtime` | **same packages, unchanged** |
| Flow + suspend/resume | `flows/InvestigateIncident.ts` | `app/incident.flow.ts` — same primitives |
| Runtimes wired by | `<LoomProvider>` React context | `@Injectable` Angular DI |
| State exposed via | hooks — `useLoom` / `useState` / `useMemo` | signals — `signal()` / `computed()` / `inject()` |
| UI rendered by | `@loom/plugin-renderer-react` + blueprints | native template `@if` / `@for` |

> The Angular app imports **nothing** from the React package — a standalone proof the runtime is UI-framework-agnostic. **BYOR: bring your own renderer.**

---

## Angular render layer — DI + signals

`onEvent` folds events into projections, then pushes slices into Angular **signals** (inside `NgZone` so change detection fires):

```ts
@Injectable({ providedIn: "root" })
export class LoomService {
  readonly phase = signal<Phase>("idle");
  readonly incidentState = signal<IncidentState | null>(null);

  constructor(private zone: NgZone) {
    this.projectionRuntime.register(IncidentProjection);
    this.workflowRuntime = new WorkflowRuntime({ /* stores, effectRuntime, */
      onEvent: (e) => this.zone.run(() => {
        this.projectionRuntime.handleEvent(e);
        this.incidentState.set({ ...this.projectionRuntime.getState("incident", execId) });
      }) });
  }
}
```

Human-in-the-loop is the **same `resume`**, just an Angular handler; the template binds straight to the signal:

```ts
await this.workflowRuntime.resume(execId, { eventType: "ApprovalGranted",
  payload: { approvedBy: "angular-operator" } });
// template:  @if (loom.incidentState()?.metrics; as m) { {{ m.cpu.current }}% }
```

---

## File map

```
src/
  App.tsx / main.tsx      command-center shell; intent routing, Approve → resume
  capabilities.ts         InvestigateCapability (intent metadata + the flow)
  flows/                  InvestigateIncident — steps + the 28-line durable runner
  tools/                  Metrics / Logs / Remediation (step$ + handler$) + AiTriage step
  projections/            MetricsProjection + IncidentProjection (timeline, status)
  blueprints/             IncidentBlueprint — StatusBadge, MetricCards, Timeline, StreamingText
  runtime/                aiTriage (streaming effect), MockLlmProvider, in-browser stores
```

`vite.config.ts` runs `loomPlugin()` — the compiler extracts each `handler$` into its own **lazy chunk**.

---

## Run it

```bash
pnpm --filter @loom/cloud-command-center dev        # React   — http://localhost:5173
pnpm --filter @loom/angular-command-center dev      # Angular — same backend, zero React
```

1. Enter a goal (or click the example) → metrics cards fill, badge → `investigating`.
2. Watch the **AI analysis stream in** → badge → `awaiting-approval`.
3. Click **Approve** → workflow resumes → badge → `resolved`. (Try a refresh first — it resumes.)

Offline by default (`MockLlmProvider` token-streams a scripted analysis);
swap one line in `runtime/aiTriage.ts` for `AnthropicProvider({ model: "claude-opus-4-8" })`.

**Verified:** `intent-flow` + `suspend-resume` e2e tests pass; `pnpm build:ui` emits the lazy chunk manifest.

---

## Takeaways

- A **durable, resumable AI workflow that runs in the browser** — refresh-safe, no server required.
- **Human-in-the-loop is a `ctx.suspend` checkpoint**, not a modal — it survives restarts.
- **Streaming AI** and **UI updates** are the *same* durable event mechanism (agent-surface patches) → both replay.
- **Intent → capability → flow**, and **events → projections → widgets** — the shape every Loom UI app shares.
- **BYOR**: the *same* durable agentic backend runs under React **or** Angular — only the render layer swaps (`examples/angular-command-center`).

> Next: the headless pipeline behind it → `agent-network-deck.md`, or multi-agent + planner → `db-command-center-deck.md`.
