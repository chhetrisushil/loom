# db-observability — a dashboard generated dynamically from intent

Ask a database a question in plain language — *"Why is the CPU utilization high?"* or
*"What is the connection saturation level?"* — and the app **generates the dashboard
UI on the fly**. An agent analyses the question, categorises it, and produces two
things:

- **WHAT** — the direct answer to your question (the headline metric + a one-line answer).
- **WHY** — the supporting information that explains *why the WHAT is the way it is* (the
  causal signals: pool saturation, slow queries, CPU trend…).

The dashboard is a Loom **blueprint assembled at runtime** from an **available widget
catalogue**, bound to live telemetry projections and rendered headlessly to the terminal.
No dashboard is hand-authored — the UI is a function of *intent × catalogue × telemetry*.

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

```bash
pnpm --filter @loom/db-observability start   # asks 4 questions, prints a generated dashboard for each
pnpm --filter @loom/db-observability test    # classification, dynamic assembly, and rendered output
```

Example (`Why is the CPU utilization high?`) renders a dashboard whose **WHAT** is the CPU
metric (91%, saturated) and whose **WHY** surfaces the connection-pool saturation, the top
slow queries, and the CPU trend — the causal story behind the number.

## Going visual

The composer emits a framework-agnostic `Blueprint`. This example renders it with
`@loom/renderer-terminal`; point `@loom/renderer-react`'s `BlueprintRenderer` at the same
blueprint + projection runtime to get a live web dashboard — the composition logic is
identical.

## Files

| Path | Purpose |
|------|---------|
| `src/telemetry.ts` | Telemetry + answer projections, the seeded scenario, snapshot reader |
| `src/catalogue.ts` | The available widget catalogue (the palette) |
| `src/topics.ts` | Per-topic WHAT/WHY causal models |
| `src/agent.ts` | Offline intent classifier (`LlmProvider`) |
| `src/composer.ts` | Classify → reason → assemble the blueprint dynamically |
| `src/app.ts` / `src/main.ts` | Wiring + headless driver |
| `test/observability.test.ts` | Classification, dynamic assembly, rendered output |
