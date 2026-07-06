# ADR 0010 — the `loom` CLI (logs / debug / eval)

- Status: Accepted (DX tooling — Phase 2)
- Date: 2026-07-07
- Builds on: [ADR 0009](0009-testing-kit.md)

## Context

Loom had no unified CLI (only `loom-compile` + `create-loom-app`) and no way to
inspect the durable event log. The through-line of the DX roadmap is that the log
is the moat and most tooling is a lens on it — so the first CLI commands expose
the log directly.

## Decision

New `@loom/cli` with bin `loom`. Each command's logic is a **pure function**; the
bin is a thin argv wrapper, so behaviour is unit-tested without spawning
processes.

- **`loom debug --db <path> <executionId> [--at N]`** — time-travel over the log.
  `foldAt(events, seq)` reconstructs the exact `ExecutionState` at any sequence,
  deterministically, with no live effects (reusing `@loom/eval`'s identity-seeded
  fold). This is the uniquely-Loom capability — principled time-travel is only
  possible because of deterministic replay + snapshots.
- **`loom logs --db <path> <executionId>`** — `formatLog` prints the event stream
  as a timeline and marks suspend points.
- **`loom eval --dir <path>`** — `evaluateGoldens` replays golden logs (stored
  `EventEnvelope[]` JSON + expectations) and checks status / output / completed
  steps; exits non-zero on failure (CI-ready).

**Scope decisions (deliberate):**
- Commands take an explicit `--db`/`--dir` path so v1 needs **no TS-config
  loading** — tractable and testable. `deploy`/`check`/`dev` (which need the app's
  flows) get config-loading in later phases.
- `loom debug` v1 is non-interactive (`--at`); an interactive REPL and
  fork-from-sequence (which needs an app load) are follow-ons.
- **No `loom create-app`** — rejected as redundant with the idiomatic
  `create-loom-app` (`npm create loom-app`), because the `loom` CLI is
  project-local (like `next`/`vite`), whereas creation is pre-project. `--help`
  hints at `npm create loom-app`; in-project generation lands as `loom new` (Phase 3).

## Consequences

- The durable log becomes directly inspectable/debuggable from the terminal.
- `foldAt`/`formatLog`/`evaluateGoldens` are exported for reuse (e.g. the Phase-6
  inspector reuses `foldAt` for its time-travel slider).
- New package: `@loom/cli` (deps: core, eval, event-runtime, replay-vm).

## Verification

- 10 tests: `parseArgs`; `foldAt` reconstructs a past sequence (running) vs final
  (suspended); `formatLog` marks the suspend; `describeState`; `cmdLogs`/`cmdDebug`
  over a real temp SQLite store recorded by a real run; graceful unknown-execution;
  `loom eval` passes/fails goldens and reports step-completion misses. `loom --help`
  smoke-verified. Full repo: build + typecheck clean, 77/77 test tasks green,
  biome clean (538).
