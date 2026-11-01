# ADR 0064 — `@loom/plugin-sandbox`: hardened eval of LLM-authored reshaping code

- Status: **Accepted** (`sandboxEval$` + `SandboxEvalEffect` on quickjs-emscripten)
- Date: 2026-07-19
- Builds on: [DE-series evaluation](../requirements/2026-07-19-dynamic-execution-de-series-evaluation.md)
  (sandboxEval$), ADR 0060 (typed channels), ADR 0063 (`canonicalJson`/shape
  hashing), ADR 0046 (content-addressed scripts), K7 (`@loom/isolate` — the
  isolation contract this follows).
- Part of: the GenUI/DE corrected series. No kernel changes.
- Amended by: [ADR 0144](0144-sandbox-backend-spi.md) (the engine becomes a `SandboxBackend` SPI in `@loom/sandbox`; QuickJS stays the default backend with the same limits, channels and security list; the success value is returned as its JSON round-trip).

## Context

Blueprint providers carry LLM-authored reshaping snippets (raw MCP output →
canonical data shape). Executing model-written code per-application is a
security anti-pattern — this must be written once and audited once. Nothing
JS-VM-shaped existed; the closest machinery, `@loom/isolate`, forks a Node child
process: real isolation, but a child holds *ambient* Node authority that must be
subtractively scrubbed (env, network modules, brokered fetch).

## Decisions

### D1 — Engine: QuickJS-in-WASM, capability-empty by construction

`quickjs-emscripten` (plugin-local dependency). A fresh QuickJS runtime holds
NOTHING but what is injected — no fs, no net, no process, no timers — so no-I/O
is a property, not a scrub list. Native `setMemoryLimit` + `setInterruptHandler`
give in-engine resource enforcement; no per-eval process spawn. `warm()`
precompiles the WASM module (the real cold-start cost), riding the existing
advisory pre-warm seam. The contract *shape* follows `IsolatedToolSpec`: a
static spec (limits, expected shape hash), scalar-marshaled context, no closures
over parent state.

### D2 — Scripts are content-addressed; blueprints pin them by hash

Input carries `scriptRef` (a `ContentRef`); the effect resolves it via the
ContentStore. Reshaping logic thereby shares the blueprint's immutability and
provenance: a repair that rewrites a script produces a NEW ref — a new blueprint
version — never a mutation. Missing script (e.g. swept after erasure) →
typed `scriptMissing`.

### D3 — Limits and outcomes are typed channels (ADR 0060)

- `limitExceeded { kind: "cpu" | "memory" | "wallClock" }` — interrupt-budget,
  memory-limit, and wall-clock kills, mapped from engine errors. Typed so a
  planner catches and re-plans, and replay substitutes without re-burning CPU.
- `shapeMismatch { expected, observed }` — the output's structural skeleton
  (sorted keys → primitive type names, hashed via the ADR 0063 canonicalization)
  vs the caller-pinned `expectedOutputShapeHash`.
- Deliberately UNTYPED: ReferenceErrors from scripts touching `fetch`/`require`/
  `process` — an environment violation is a bug, not a domain outcome; it keeps
  legacy retry semantics and loud failure. *(Superseded 2026-09-27 by the
  `scriptError` bullet below: those ReferenceErrors are now `scriptError`.)*
- *(Added 2026-09-27.)* `scriptError { name?: string; message: string }` — the
  script's OWN exception on this input: any thrown value (an Error, a non-Error such
  as `throw 42` → `{ message: "42" }`), a SyntaxError in its source, a stack overflow,
  and a ReferenceError for a global the VM does not have, which the VM cannot tell
  apart from a typo. A caller can tell "the script threw on this input" from an
  infrastructure failure without parsing error text; being a pure function of
  (script, input) it is an outcome — substituted on replay, not retried.
  - Payload: the thrown value's `name` only when it is a string (≤ 128 UTF-16 units)
    and a text `message` (≤ 2048), never a stack. Truncation never splits a
    surrogate pair, and lone surrogates and NUL become U+FFFD, so the event is
    storable in Postgres `jsonb`. The text is script-authored (often by a model):
    data for a planner or a log, never a prompt instruction.
  - Precedence: a guard kill is `limitExceeded` even when the script catches it and
    rethrows. Memory/CPU are read from the text ONLY of the engine's own
    `InternalError`, so `throw new Error("connection interrupted")` is `scriptError`
    (a script constructing `new InternalError("out of memory")` itself is reported
    as the kill it forges — still typed).
  - Still untyped (infrastructure): the worker pool (closed, a worker `fatal`, a run
    that never started), the content-address check, input marshalling, cancellation.
  - Replay is additive: an old log's untyped STEP_FAILED has no channel, so it is
    never substituted as `scriptError` and keeps ADR 0060's legacy re-execution — a
    paused run resumed on this version re-runs that step and now receives a
    `TypedFailure`.

`idempotent: true` — a pure function of (script, input); at-least-once re-runs
are safe by construction.

## Consequences

- One audited sandbox for every loom application that executes model-authored
  transforms; the security test list (runaway loop, allocation bomb, wall-clock,
  no-I/O, shape mismatch, erased script, determinism) is the audit's executable
  form.
- Spec capability `sandbox-eval` (L2); evidence
  `plugins/sandbox/src/sandbox.test.ts`.
