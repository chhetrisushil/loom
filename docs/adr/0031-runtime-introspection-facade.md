# ADR 0031 — Runtime Introspection facade

- Status: Proposed (2026-07-10) — accepted item #4 in the [Execution-OS evaluation](../requirements/2026-07-10-execution-operating-system-evaluation.md)
- Date: 2026-07-10
- Builds on: `@loom/event-runtime` (`BranchRegistry`), `@loom/replay-vm` (`foldAt`), `@loom/analytics`, `@loom/dispatcher`, `@loom/cli`

## Context

Every graph the requirements' "Runtime Introspection" item asks for is *already derivable* today —
execution/task graph from the fold, lineage from `BranchRegistry`, decisions from analytics,
resources from `_resources`, placement from the dispatcher registry — but each via a different
package and shape. There is no single **programmatic** read-only facade. (The "Fiber Graph" is the
task graph; fibers were rejected — see the evaluation.)

## Decision

Add a read-only `introspect(config)` facade (surfaced in `@loom/analytics` or a thin `@loom/introspect`)
returning typed graphs, all folded from existing sources — no new state, no durable events:

- **execution / task graph** — from the folded `ExecutionState` frames.
- **decision graph** — delegated to `DecisionGraph` (ADR 0030) when present.
- **resource graph** — from `_resources` / `RESOURCE_METERED`.
- **placement graph** — from the `PlacementDispatcher` target registry + lineage.
- **dependency graph** — capability/tool dependencies from the compiler manifest + `GrantTable`.

CLI `loom introspect <executionId> --graph <name>` prints any graph; the same models back the
observability view (ADR 0029) and verification (ADR 0028).

## Consequences

- One import, one shape, for "what does the runtime look like right now" — read-only over the log.
- Determinism untouched (G1); zero-overhead when unused (G2).
- Deliberately *not* a mutation API: introspection observes; it never steers execution.

## Verification

- Each graph reconstructs the expected nodes/edges for a fixture execution (fork included).
- Facade runs offline from a stored DB; emits no events.

## Amendments (from the Execution-OS evaluation)

- "Fiber Graph" renamed to task/execution graph (fibers rejected).
- Absorbs the DX-facade slice of "Unified Runtime Context": a typed *accessor* over subsystems,
  **without** collapsing `ExecutionContext`/`EffectContext` into a god-context (which was rejected).
