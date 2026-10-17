# ADR 0014 — `loom deploy check` + the inspector

- Status: Accepted (DX tooling — Phase 6)
- Date: 2026-07-07
- Builds on: [ADR 0013](0013-orchestrator-primitives.md)

## Context

The final DX phase: operationalize deploy-simulation (Tier 3B) as a CLI gate, and
give the `loom debug` time-travel a visual home. Per the discipline, ship the
testable data/HTTP cores and a minimal view — not a large untested UI.

## Decision

**`loom deploy check --logs <dir> --config <module>`.** `runDeployCheck(logs,
resolver)` is a pure wrapper over `simulateDeploy`; `loadLogs` reads stored
`EventEnvelope[]` JSON files; the config module supplies a `getFlow`-shaped
resolver (a `WorkflowRuntime` booted with the *new* code — build to JS or run
under tsx). Exits non-zero on any breaking change — the pre-promote CI gate.

**Inspector.** `buildTrace(events)` (pure) is the render model: the event timeline
plus the folded status at every sequence, reusing `foldAt` so the visual slider
and `loom debug` share one deterministic time-travel engine. `serveInspector`
(node:http) exposes `/api/trace/:id`, `/api/state/:id/:seq` (the same `foldAt`),
and a single-file, dependency-free HTML timeline + slider. `loom inspect --db
<path>` (alias `loom dev`) serves it over SQLite.

**Deliberately deferred:** a rich `@loom/renderer-react` inspector and the full
`loom dev` watch loop (gen-on-change + run the app + live SSE). The reusable
engine (`buildTrace`/`foldAt`) and the API are tested now; a heavier UI shipped
untested would violate the project's discipline and is a follow-on once usage
patterns are known.

## Consequences

- Deploy-sim is now a one-command CI gate; the durable log's differentiators
  (evals, deploy-sim, logs, debug, inspector) are all reachable from `loom`.
- The inspector's data layer is fully tested; the thin HTML view is a static asset.
- `@loom/cli` gains a `@loom/deploy-sim` dependency; the `loom` CLI now has eight
  commands.

## Verification

- `@loom/cli` (+ to 19 total): `buildTrace` (timeline + per-sequence status;
  running→…→suspended); `loadLogs`; `runDeployCheck` (identical deploy ok, removed
  flow breaking); `serveInspector` live over SQLite — `/` serves the page,
  `/api/trace` returns the model, `/api/state/:seq` returns the folded state,
  unknown → 404. `loom --help` shows all eight commands.
- Full repo: build + typecheck clean, 82/82 test tasks green, biome clean (559).

> Erratum (2026-10-17): `loom dev` is no longer an alias of `loom inspect`; it is the dev loop (gen --watch + run the app + the inspector). `loom inspect <store>` is the inspector alone. See `docs/usage-cli.md`.
