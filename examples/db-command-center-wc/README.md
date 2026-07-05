# DB Command Center — Web Components

The **same** agentic database command center as `examples/db-command-center`,
rendered with **vanilla Web Components (Custom Elements)** — no React, no Angular,
no framework at all. It's the clearest demonstration of Loom's **BYOR**
(bring-your-own-renderer): the entire agentic backend is reused byte-for-byte,
and only the render layer is swapped.

```
pnpm --filter @loom/db-command-center-wc dev      # http://localhost:5173
pnpm --filter @loom/db-command-center-wc build:ui # production bundle
```

Fully offline (deterministic `DemoLlmProvider`); swap it for
`AnthropicProvider({ model: "claude-opus-4-8" })` in `src/runtime/services.ts` to
go live.

## What's reused vs. what's new

**Reused verbatim from the React example** (all framework-agnostic):
`domain`, `runtime/*`, `agents/*`, `capabilities/*` (durable flows), `a2a/*`
(in-process A2A transport), `orchestrator/*`, `blueprints/*` (the `blueprint$`
definitions), and `widgets/customWidgets.ts` (the `customWidget$` kinds). Same
Planner → A2A → durable-suspend/resume → human-in-the-loop pipeline.

**New — the Web Components render layer** (`src/dom/` + `src/main.ts`):

| Piece | Role |
|---|---|
| `dom/elements.ts` | **BYOC/BYOR on the platform** — one Custom Element per widget kind (`dcc-agent-task-list`, `dcc-gauge`, `dcc-risk-approval`, …). Each has a `.value` setter that re-renders itself; actions bubble as `widget-action` CustomEvents. |
| `dom/BlueprintDom.ts` | The framework-agnostic **BYOR core**: `traverseBlueprint<HTMLElement>` mounts a custom element per widget + a `<div>` per layout node, and subscribes each widget to **only its own projection slice**. |
| `dom/latencyChart.ts` | Native dynamic `import()` — code-splitting the chart (the platform's answer to `React.lazy`). |
| `main.ts` | Wires the identical backend and builds the shell (intent bar, tabs, tab-independent approval banner) as plain DOM. |

## The "fiber" capability, without a framework

React's fiber gives granular updates (only the changed widget re-renders),
suspense, and deferred streaming. This example reproduces the **same behavior on
the platform**:

- **Granular updates** — every custom element subscribes to exactly its bound
  projection path (`ProjectionRuntime.subscribe`) and updates only its own
  `.value`. A projection event re-renders one task row, never the whole tree —
  the same win React's fiber renderer provides, with no reconciler.
- **Deferred streaming** — the `InMemoryProjectionRuntime({ coalesceNotifications: true })`
  batches a streaming burst (many console lines) into one notification per
  microtask, so the high-frequency `dcc-console-log` doesn't thrash the DOM.
- **Lazy / suspense** — `dcc-latency-chart` shows a placeholder, then native
  dynamic-imports its implementation and swaps it in — no sibling blanking.

## Requirement mapping

Identical to the React example (see its README): intent/goal-driven +
human-in-the-loop, workflow composed dynamically by the Planner, domain agents
over A2A, long-running durable agents, a near-real-time agent-task list, tasks
created per plan step, and an observability dashboard — here every surface is
rendered by a Custom Element.
