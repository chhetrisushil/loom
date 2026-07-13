# cloud-command-center — an incident command center in React

A reference **React** application: a "cloud database command center" that investigates an incident with
a durable Loom flow and renders the live result. It's the browser-side companion to the headless
examples — same durable runtime, assembled once with `defineConfig`, driving a UI.

## What it shows

- **One declarative composition root** — `defineConfig` (in `src/main.tsx`) assembles the stores, the
  `EffectRuntime`, the `WorkflowRuntime`, and the A2UI `"ui"` surface. The app registers **custom
  projections** (`MetricsProjection`, `IncidentProjection`), so it builds its own
  `InMemoryProjectionRuntime` and hands it in.
- **A durable investigate-incident flow** (`src/flows/InvestigateIncident.ts`) — gather metrics + logs,
  AI-triage, then a human-approved remediation (`ctx.suspend` → resume from the log).
- **AI triage as a swappable effect** — `registerAiTriageEffect` wires a `MockLlmProvider`
  (`src/runtime/`); point it at a hosted `@loom/llm` provider to go live.
- **A2UI-driven UI** — the flow patches the `"ui"` surface; the React `LoomProvider` +
  `BlueprintRenderer` bind to it. Widgets read `{ projectionId: "ui" | "metrics" | "incident", path }`.

## Run it

```sh
pnpm --filter cloud-command-center dev     # Vite dev server
pnpm --filter cloud-command-center test    # intent-flow + e2e suspend/resume
```

The same durable backend is rendered in other frameworks by its siblings —
[`angular-command-center`](../angular-command-center) (Angular) and the
[`db-command-center`](../db-command-center) family (React / Web Components / server-split). Loom is
frontend-framework-agnostic: only the renderer changes.
