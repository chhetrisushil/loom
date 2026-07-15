# Perpetual-agents series audit (W8) — DS&A, security, memory leaks

**Date:** 2026-07-15 · **Scope:** everything merged in the series (PRs #174–#180; ADRs
0051–0056) · **Method:** three independent lenses over the merged code, findings fixed
in-pass or deferred with rationale (the Phase-6-audit discipline). Fixes shipped with
[ADR 0057](../adr/0057-multi-gate-suspend-passthrough.md).

## Fixed in-pass

| # | Finding | Severity | Fix |
| --- | --- | --- | --- |
| F1 | **Multi-gate suspend silent bug** (pre-existing kernel, surfaced by the W4 work): the fold kept only the LATEST resume payload and the context passthrough was single-shot — on the second resume of a two-gate flow, gate 1 passed through with gate 2's payload and the run re-parked forever. Confirmed as bug (c) by mechanism trace; no existing flow/test used two sequential bare gates. | HIGH (silent wrong-payload) | Ordered `_resumePayloads` fold list (EVENT_SCHEMA 1.16.0), passthrough consumes payload *i* at gate *i*; legacy single-payload fallback for pre-1.16 snapshots. ADR 0057; 3 regression tests. |
| F2 | `collectContentRefs` (gc sweep) recursed unbounded — a pathologically deep or cyclic payload stack-overflows the retention job (DoS of the sweep). | MEDIUM | Iterative queue + `WeakSet` cycle detection. |
| F3 | `stableStringify` (durable-state adopt-own-write check) recursed unbounded — deep save payloads could stack-overflow the save path. | MEDIUM | Depth cap (256) with a loud `RangeError`; save fails typed, process survives. |
| F4 | `lintClaimCheck` tree walk followed symlinks (loops / tree escape; CLI-trusted input, hardening). | LOW | Symbolic links skipped. |

## Clean (no findings)

**Memory/resources** — audited and clean: `liveHandles` deleted in `finally` on every
settle path (including typed-error failures); `ExecutionJournal` promise chain bounded by
run length and released on settle; `TimerService` interval `unref`'d with `stop()`;
sqlite/postgres stores own their handles with `close()` and pool-ownership flags; gc mark
maps are sweep-scoped; the middleware closure retains config only; the 1,460-execution
example is O(total events).

**Security** — parameterized SQL throughout both new stores; no prototype-pollution
vector (`Object.keys/values` walk own properties only); tenant scoping holds through the
sweep when `TenantScopedEventStore` wraps the store; `transformState` and migrations are
operator-supplied by documented trust model; resume paths correctly *don't* re-validate
(the folded `_input` was validated at start/migration); forged claim-check envelopes are
lint-flagged and resolve to `null`, never a crash.

## Deferred with rationale (DS&A suggestions rejected — correctness/invariants win)

| Suggestion | Why deferred/rejected |
| --- | --- |
| Postgres CAS: fold the conflict `SELECT` into `RETURNING` | Incorrect: a guarded `UPDATE`/`INSERT` that affects zero rows returns zero rows — the actual revision still needs the follow-up read. Current shape (one statement on success, one extra read only on the rare conflict) is already minimal. |
| Claim-check: avoid `JSON.stringify` before the size check | No sound cheaper measure exists — sampling/heuristics can under-count and break the cap invariant. The journal serializes the recorded value anyway; the cap check is the same work done once, early. |
| `InMemoryDurableStateStore`: drop a clone on save | The clones are the value-semantics contract (callers must never alias store internals — the property the durable backends give via JSON round-trip). Equal cost either way; contract wins. |
| `canonicalEqual` fast-path before stringify | Runs only on the rare CAS-conflict recovery path; payload references are never identical there (store clones). No measurable win. |
| gc sweep "O(n²)" | Misread: the mark phase is a single pass per event, O(total payload bytes) — optimal for log-derived mark-and-sweep. The recursion risk was real and is fixed (F2). |
| `LogLifecycle.hasLiveDescendant` batch reads | Already early-exits on the first live child; no cheaper store primitive exists. Revisit only if a real high-fan-out retention pass shows up. |
| lint line-splitting; `taskWith` spread | Negligible at real scales (linter is offline tooling; the spread is once per durable-state call vs. its store I/O). |

## Series-wide invariants re-checked

EVENT_SCHEMA history is linear and additive (1.14.0 → 1.15.0 K11.5 → 1.16.0 ADR 0057);
`knownEventTypes()`/PINNED unchanged all series; KERNEL_ABI 1.1.0 untouched; every
kernel option added (pinned, transformState, validateInput, now, TimerService.now) is
opt-in with `Date.now`/off defaults (G2), each with an explicit regression test of the
unwired path.
