# Loom Documentation

Start here. The docs are a progressive funnel — read top to bottom, or jump to what you need.

| Doc | Read it when you want to… |
|---|---|
| **[Getting Started](getting-started.md)** | Go from zero to a running, suspend/resume flow in ~5 minutes. |
| **[Usage Guide](usage.md)** | Build a realistic app step by step (steps → flow → config → suspend/resume → agents → branching → ship). |
| **[User Guide](user-guide.md)** | Look up a specific feature: fork, A2A, middleware, projections, testing, CLI, compute… |
| **[Architecture](architecture.md)** | Understand the mission, core principles, the runtime model, and *why* each decision was made. |
| **[Presentation](presentation/loom-deck.md)** | Present Loom — the flagship deck (Marp). More decks in [`presentation/`](presentation/). |
| **[ADRs](adr/)** | Read the full decision history (0001–0015), one record per decision. |

## The one-paragraph version

A Loom workflow is an ordinary `async` TypeScript function whose every meaningful step is recorded to a durable, append-only **event log**. State is `fold(events)` — a pure, deterministic reconstruction — so an execution can **pause for a human, resume on another machine, replay bit-for-bit, fork to explore alternatives, and be evaluated against its own history**. The durable log is the moat; durability, resumability, replay, branching, evals, and time-travel debugging are all just *lenses on it*.

## Also in this folder

- [`api-reference.org`](api-reference.org) — exhaustive per-package API reference.
- [`usage-compiler.org`](usage-compiler.org) — the optional `@loom/compiler` (build-time `handler$` extraction, resumability).
- [`benchmarks.md`](benchmarks.md) — committed performance baselines.
- [`examples/`](examples/) — reference walkthroughs (`acme-support`, a Postgres storage backend).

## Runnable examples

See [`../examples`](../examples):

- **[`loom-starter`](../examples/loom-starter)** — **start here.** The canonical new-architecture example: `defineConfig` + folder convention (`loom gen`) + effect middleware + `@loom/testing` + evals + deploy-sim + the compute seam, in one compact release-approval app.
- `agent-network` — the full agentic pipeline (LLM, ReAct agent, MCP, A2A, intent, planner, memory).
- `db-command-center` — intent → planner → A2A dispatch → durable human approval (same backend rendered in React, Web Components, and Angular).
- `incident-war-room` & `schema-migration-planner` — git-style branching (fork → simulate → compare → promote).
