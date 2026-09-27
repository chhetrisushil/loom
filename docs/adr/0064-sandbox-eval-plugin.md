# ADR 0064 — `@loom/plugin-sandbox`: hardened eval of LLM-authored reshaping code

- Status: **Accepted** (`sandboxEval$` + `SandboxEvalEffect` on quickjs-emscripten)
- Date: 2026-07-19
- Builds on: [DE-series evaluation](../requirements/2026-07-19-dynamic-execution-de-series-evaluation.md)
  (sandboxEval$), ADR 0060 (typed channels), ADR 0063 (`canonicalJson`/shape
  hashing), ADR 0046 (content-addressed scripts), K7 (`@loom/isolate` — the
  isolation contract this follows).
- Part of: the GenUI/DE corrected series. No kernel changes.

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
  legacy retry semantics and loud failure. *(Amended 2026-09-27: superseded by the
  `scriptError { name?, message }` channel. A script's OWN exception — any thrown
  value, a SyntaxError in its source, and a ReferenceError for a global the VM does
  not have, which the VM cannot tell apart from a typo — completes typed, so a
  caller can tell "the script threw on this input" from an infrastructure failure
  without parsing error text. Being a pure function of (script, input) it is an
  outcome: substituted on replay, not retried. The payload is the thrown value's
  string `name` (when it has one, ≤ 128 chars) and a text `message` (≤ 2048 chars),
  never a stack. A guard kill stays `limitExceeded` even when the script catches it
  and rethrows. What stays untyped is the infrastructure: the worker pool (closed, a
  worker `fatal`), the content-address check, input marshalling, cancellation.
  Additive for replay: an old log's untyped STEP_FAILED carries no channel, so it is
  never substituted as `scriptError` and keeps ADR 0060's legacy re-execution.)*

`idempotent: true` — a pure function of (script, input); at-least-once re-runs
are safe by construction.

## Consequences

- One audited sandbox for every loom application that executes model-authored
  transforms; the security test list (runaway loop, allocation bomb, wall-clock,
  no-I/O, shape mismatch, erased script, determinism) is the audit's executable
  form.
- Spec capability `sandbox-eval` (L2); evidence
  `plugins/sandbox/src/sandbox.test.ts`.
