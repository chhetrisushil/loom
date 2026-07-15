# Loom

**A durable execution runtime for intelligent software.** Loom runs workflows and agents on an
event-sourced, deterministic core: every step, effect, and decision is journaled, so an execution
can suspend, resume, fork, replay bit-for-bit, and recover across process or machine boundaries —
while the "smart" parts (reasoning, scheduling, memory, optimization) stay optional and can only
influence *outcomes* through logged decisions, never as a hidden input to the fold.

> Licensed under **Apache-2.0** (see [`LICENSE`](LICENSE)).

## Why

- **Deterministic durability.** The durable log is the source of truth; replay is a pure fold, so
  the same execution reconstructs identically forever — even as outcomes improve run-to-run.
- **Minimal kernel, everything else composable.** The core is small (execution + event log +
  determinism + effect isolation). Storage, compute placement, reasoning, telemetry, renderers, and
  protocols are all **pluggable seams**, not kernel code.
- **Intelligence, but logged.** Model routing, elevation, and learning are allowed — each recorded
  as a durable decision and served from the log on replay.

See [`docs/architecture.md`](docs/architecture.md) for the principles (P1–P11) and the design.

## Repository layout

| Tier | Location | What |
|---|---|---|
| **Kernel** | `packages/` | mechanism + ABI: `core`, `event-runtime`, `snapshot-runtime`, `replay-vm`, `effect-runtime`, `workflow-runtime`, `scheduler`, `wire-abi` |
| **SPI contracts** | `packages/` | the seams adapters implement: `worker-runtime`, `projection-runtime`, `llm`, `blueprint-runtime`, `registry`, `telemetry`, `dispatcher` |
| **Advisory** | `packages/` | optional modules: `reasoning`, `memory`, `agent`, `planner`, `intent`, `capability`, `saga`, `orchestration`, `analytics`, `middleware`, `app`, `classify` (data-sensitivity markers), `compliance` (GDPR subject rights), … |
| **Plugins (1P adapters)** | `plugins/` | `@loom/plugin-*`: `sqlite`, `postgres`, `crypto`, `content` (content-store seam), `durable-state` (typed, contract-migratable carry state), `read-model` (durable cross-execution event index), `sentinel` (the perpetual-agent pattern as one preset), `audit-chain`, `cloudrun`, `worker-remote`, `worker-server`, `mcp`, `a2a`, `renderer-react`, `renderer-terminal` |
| **Plugin authoring** | `packages/` | `@loom/plugin-kit` (typed presets), `@loom/conformance` (SPI conformance kits) |
| **Tooling** | `tools/` | first-party dev-tooling (leaf, build/test/authoring only): `cli`, `compiler`, `appgen`, `appgen-model`, `deploy-sim`, `scaffold`, `eval`, `testing`, `dst`, `create-loom-app`. (`verify`, `spec`, `conformance` stay in `packages/` — runtime/governance-adjacent.) |

Third-party plugins live anywhere under the `loom-plugin-*` name (curated in the companion
[`loom-plugins`](https://github.com/chhetrisushil/loom-plugins) repo). See
[`docs/plugins.md`](docs/plugins.md) and [ADR 0043](docs/adr/0043-plugin-packaging-and-1p-3p-separation.md).

## Quickstart

```bash
npm create loom-app        # scaffold a new app
```

```ts
import { defineConfig } from "@loom/app";
import { sqliteStorage } from "@loom/plugin-sqlite";
import { flowModules } from "./app/loom.gen"; // from `loom gen` (static discovery)

export const app = defineConfig({
  storage: sqliteStorage({ dir: ".loom" }), // or { kind: "memory" }, or your own preset
  flowModules,
});
```

Storage backends are **presets** (`sqliteStorage`, `postgresStorage`, …) that return a `custom`
descriptor, so the composition root names no vendor — a third-party backend wires identically.

## The `loom` CLI

```
loom gen | new                     scaffold flows/agents/tools (folder convention)
loom plugin new|check|try|search|seams   author, validate, and discover plugins
loom logs | debug | profile | introspect   inspect the durable log (time-travel)
loom check | verify | deploy check         static + pre-flight + deploy-simulation gates
loom appgen <intent>               AI-native, brownfield-aware codegen (NL → static TS)
```

Full reference: [`docs/usage-cli.md`](docs/usage-cli.md).

## Develop

```bash
pnpm install
pnpm build        # turbo build (tsc project references)
pnpm test         # vitest across all packages
pnpm lint         # biome
pnpm fitness      # build + typecheck + lint + test
```

Node ≥ 20, pnpm ≥ 9. Architecture decisions are recorded in [`docs/adr/`](docs/adr/).
