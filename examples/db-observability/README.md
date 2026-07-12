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

## How it works

- **Telemetry projections** (`src/telemetry.ts`) — `cpu`, `connections`, `replication`,
  `queries` read-models, seeded with a deterministic "DB under CPU stress" scenario,
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
pnpm --filter @loom/db-observability start   # asks 4 questions, prints a generated dashboard for each
pnpm --filter @loom/db-observability test    # classification, dynamic assembly, rendered output, registry
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
| `src/telemetry.ts` | Telemetry + answer projections, seeded scenario, live-sample helpers |
| `src/catalogue.ts` | The available widget catalogue (the palette) |
| `src/topics.ts` | Per-topic WHAT/WHY causal models |
| `src/agent.ts` | Offline intent classifier (`LlmProvider`) |
| `src/composer.ts` | Classify → reason → assemble the blueprint dynamically |
| `src/wiring.ts` | `buildCore` — surface-agnostic projections + composer (terminal-free) |
| `src/app.ts` / `src/main.ts` | Terminal wiring + headless driver |
| `src/browser/` | React dashboard: `renderers.tsx` (Recharts), `registry.ts`, `App.tsx`, `main.tsx` |
| `test/` | Classification, dynamic assembly, rendered output, browser registry |
