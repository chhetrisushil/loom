# db-observability — a dashboard generated dynamically from intent

Ask a database a question in plain language — *"Why is the CPU utilization high?"* or
*"What is the connection saturation level?"* — and the app **generates the dashboard
UI on the fly**. An agent analyses the question, categorises it, and produces two
things:

- **WHAT** — the direct answer to your question (the headline metric + a one-line answer).
- **WHY** — the supporting information that explains *why the WHAT is the way it is* (the
  causal signals: pool saturation, slow queries, CPU trend…).

The dashboard is a Loom **blueprint assembled at runtime** from an **available widget
catalogue**, bound to live telemetry projections. No dashboard is hand-authored — the UI
is a function of *intent × catalogue × telemetry*. The same blueprint renders on **two
surfaces**: a headless terminal (text) and a **React dashboard where the WHAT/WHY metrics
are drawn as visualisations** (a radial gauge, an area chart, a saturation bar, a table).

```
 question ─▶ agent.classifyIntent ─▶ { topic, kind }
                                         │
              ┌──────────────────────────┘
              ▼
   TOPIC_MODELS[topic]:  answer(telemetry) → WHAT     explanation(telemetry) → WHY
              │                    primaryWidget            whyWidgets[]
              ▼
   DashboardComposer  ── selects widgets from ──▶  WIDGET_CATALOGUE
              │                                          (MetricCard, ProgressBar,
              ▼                                           Timeline, DataTable, …)
   blueprint$(stack([ WHAT badge + metric,  WHY badge + causal widgets ]))
              │
              ▼
   TerminalRenderer.render(blueprint, executionId)   ← binds to cpu/connections/… projections
```

Telemetry itself is **hydrated by a transient interpreter** (the GenUI
blueprint-interpreter pattern, ADRs 0060/0061/0063/0064/0065): a *hydration plan* — one
node per projection, each naming an MCP tool, a **pinned input-schema hash**, and a
**content-addressed reshaping script** — is walked by plain code. Because hydration is the
hot read path (every dashboard open, every 50 ms batch) and mutates nothing, it is **not a
loom run** (ADR 0065 — "don't make it a run until something durable happens"): each effect
runs through `runtime.invokeTransient`, writing **zero events**.

```
 plan (immutable, content-addressed — never logged on the hot path)
   │  one node per projection: { toolName, schemaPin, scriptRef, shapePin }
   ▼
 invokeTransient("mcp.invoke", node)            ← transient, no events
   │  per call: verify schemaPin — mismatch ⇒ TYPED schemaDrift failure (ADR 0060/0063)
   ▼
 invokeTransient("sandbox.eval", …)             ← QuickJS sandbox: RAW → widget shape,
   │                                               output validated vs shapePin (ADR 0064)
   ▼
 { cpu, connections, replication, queries } → seeded into the projections
```

Midway through the demo a simulated **backend deploy changes `db.replication`'s input
schema**: the pinned hash no longer matches and the transient invoke fails on the **typed
`schemaDrift` channel**. *That* is the moment the determinism boundary is crossed — a
repair must be recorded — so hydration escalates to a **durable repair run**
(`start(repairFlow, …)`): it emits `SCHEMA_REPAIRED` (the forensic payload), re-walks the
plan under the observed pin, and re-runs the drifted node under a re-minted
`hydrate#2#repair` id (ADR 0061 — a deliberate retry is a NEW identity). The transient
failure itself is never a durable fact; only the repair outcome is. The MCP "backend" runs
in-process (`src/mcpServer.ts`) — still offline, still deterministic.

## How it works

- **Transient hydration + durable repair** (`src/hydration.ts` + `src/mcpServer.ts`) — the
  interpreter above: plain-code `invokeTransient` over `mcp.invoke` (`@loom/plugin-mcp`,
  schema pins from `listTools`) chained into `sandbox.eval` (`@loom/plugin-sandbox`,
  content-addressed scripts in a `ContentStore`), escalating to a durable repair flow
  (`fanout$` from `@loom/orchestration`) only on the typed drift→repair branch.
- **Telemetry projections** (`src/telemetry.ts`) — `cpu`, `connections`, `replication`,
  `queries` read-models, populated from the hydration flow's output (the browser build
  keeps the deterministic seeded scenario — hydration is the Node/terminal path),
  plus an `answer` projection the agent writes its WHAT/WHY text into.
- **Widget catalogue** (`src/catalogue.ts`) — the palette the UI is built from: each
  entry knows its topic + how to build a bound `Widget` (`MetricCard`, `ProgressBar`,
  `Timeline`, `DataTable`).
- **The agent** (`src/agent.ts`) — a deterministic offline `LlmProvider` classifies the
  question into `{ topic, kind }`; swap in `AnthropicProvider` and the classifier is
  unchanged.
- **Topic models** (`src/topics.ts`) — the causal map: per topic, the WHAT widget, the
  WHY widgets, and the two narrative strings derived from live telemetry.
- **The composer** (`src/composer.ts`) — ties it together: classify → reason (WHAT/WHY)
  → publish the answer → **assemble the blueprint from the catalogue** for that intent.

Because `blueprint$`, `stack`, and the widget factories return plain data, the layout's
`children` array is assembled conditionally at runtime — a `cpu` question yields a
different dashboard than a `connections` one, all from the same catalogue.

## Run it

**Visual dashboard (browser):**

```bash
pnpm --filter @loom/db-observability dev       # http://localhost:5173 — ask a question, watch the charts
pnpm --filter @loom/db-observability build:ui  # production bundle (dist/ui)
```

Ask *"Why is the CPU utilization high?"* and the **WHAT** renders as a radial **gauge**
(91 %, red zone) and the **WHY** as an area **chart** (CPU trend), a saturation **bar**
(98/100 pool), and a **table** of the top slow queries — the causal story, visualised.
Different questions generate different charts from the one catalogue. Toggle **Live** to
push deterministic samples so the gauge/area animate.

**Headless (terminal):**

```bash
pnpm --filter @loom/db-observability start   # hydrate via MCP+sandbox, ask 4 questions, drift+repair midway
pnpm --filter @loom/db-observability test    # classification, dynamic assembly, hydration + drift repair, registry
```

## One blueprint, two surfaces

The composer emits a **framework-agnostic `Blueprint`** — the intent→WHAT/WHY brain
(`agent`/`topics`/`catalogue`/`composer`) is shared verbatim. Only the *rendering* differs:
- **terminal** (`@loom/plugin-renderer-terminal`) prints each widget as `title: value`.
- **browser** (`@loom/plugin-renderer-react`) renders the *same* blueprint with a custom
  `RendererRegistry`: our Recharts renderers (`src/browser/renderers.tsx`) are registered
  under the standard widget-kind names and merged over the built-ins, so `MetricCard` →
  gauge, `Timeline` → area chart, `ProgressBar` → bar, `DataTable` → table. No catalogue
  change — the surface is a swap of the registry.

## Files

| Path | Purpose |
|------|---------|
| `src/hydration.ts` | The durable interpreter flow: plan builder + `fanout$` → `mcpInvoke$` → `sandboxEval$` + drift repair |
| `src/mcpServer.ts` | In-process MCP telemetry server (offline) + the `upgradeReplicationTool` drift trigger |
| `src/telemetry.ts` | Telemetry + answer projections, `applyHydratedStates`, seeded scenario (browser), live-sample helpers |
| `src/catalogue.ts` | The available widget catalogue (the palette) |
| `src/topics.ts` | Per-topic WHAT/WHY causal models |
| `src/agent.ts` | Offline intent classifier (`LlmProvider`) |
| `src/composer.ts` | Classify → reason → assemble the blueprint dynamically |
| `src/wiring.ts` | `buildCore` — surface-agnostic projections + composer (terminal-free) |
| `src/app.ts` / `src/main.ts` | Terminal wiring + headless driver |
| `src/browser/` | React dashboard: `renderers.tsx` (Recharts), `registry.ts`, `App.tsx`, `main.tsx` |
| `test/` | Classification, dynamic assembly, rendered output, browser registry, hydration + drift repair |
