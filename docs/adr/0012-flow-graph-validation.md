# ADR 0012 — Flow-graph validation (`loom check` + `defineConfig({validate})`)

- Status: Accepted (DX tooling — Phase 4)
- Date: 2026-07-07
- Builds on: [ADR 0011](0011-folder-convention-codegen.md)

## Context

Wiring bugs (a step whose tool has no effect, a capability→agent map pointing at
a missing capability) currently surface only at dispatch time as a runtime error.
A "typecheck for flows" should catch them earlier — and must work for the 8/9 apps
that don't run the handler-extraction compiler.

## Decision

**`validateFlowGraph` (pure, `@loom/app`)** — tractable structural checks:
- `missing-effect`: a step whose `toolId` has no registered effect.
- `dangling-capability-agent`: a `capabilityAgents` entry with no matching
  capability.
Deliberately **out of scope**: step-output→next-step-input schema dataflow, which
needs analysis of arbitrary runner code.

**Boot-time (`defineConfig({ validate })`)** is the rich surface — it has the live
runtime, so it enumerates registered flows (new `WorkflowRuntime.getFlowIds()`) +
`effectRuntime.has` + `catalog.get`. `true`/`"warn"` reports via `onWarn`;
`"error"` throws on the first error (CI gate).

**Static (`loom check --manifest <path>`)** works without an app load: it surfaces
the compiler manifest's per-flow `warnings` and exits non-zero — a lightweight CI
check over what the compiler already emitted.

## Consequences

- The common "No effect registered for toolId" error is caught at boot instead of
  mid-dispatch; `validate: "error"` makes it a hard startup failure.
- Two surfaces by design: rich boot-time validation where the runtime lives, and a
  cheap static manifest check where it doesn't — neither forces the compiler on.
- Additive only: `WorkflowRuntime.getFlowIds()`, `defineConfig`'s `validate`, and
  `loom check`. No behavior change when `validate` is unset.

## Verification

- `@loom/app` (+6): `validateFlowGraph` flags a missing effect / dangling
  capability map and passes a sound graph; `defineConfig({validate})` warns at
  boot, `"error"` throws, and is silent when handler steps auto-register effects.
- `@loom/cli` (+1): `checkManifest` collects per-flow warnings and reports ok/not.
- Full repo: build + typecheck clean, 79/79 test tasks green, biome clean (549).
