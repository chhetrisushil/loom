# Three-Direction Arc — Codebase Audit & Fixes (2026-07-11)

Phase 6 of the three-direction kernel arc: a targeted audit of the seven new/changed packages
(`@loom/dst`, `audit-chain`, `fair-scheduler`, `live-query`, `orchestration`, `saga`, and the C.1
`WorkflowRuntime` changes) for **DS&A hot-path efficiency, memory leaks, and vulnerabilities**, run
as three parallel focused reviews and triaged strict-gatekeeper (fix real issues; reject overstated
ones with a reason).

## Fixed

**Memory leaks (3 real unbounded-growth bugs in long-lived processes):**
- `audit-chain` `lastHash` Map grew one entry per all-time execution → **evict on a terminal event**
  (`EXECUTION_COMPLETED/FAILED/CANCELLED`) and on `deleteExecution`; a rare post-terminal append just
  cold-reads the tail (correct, slightly slower). Now bounded to in-flight executions.
- `orchestration` supervisor `specs`/`started` grew one entry per all-time child → **delete both when
  a child reaches a terminal event**.
- `fair-scheduler` `lanes` never evicted an idle tenant → **evict a lane when it drains to empty**
  (in `nextItem` and the cancel path). This also fixes the DS&A finding below.

**DS&A:**
- `fair-scheduler` `nextItem` scanned the whole rotation `O(all-time tenants)` per dispatch. Lane
  eviction bounds `rotation` to **currently-active** tenants, so the scan is `O(active tenants)`.
- (`audit-chain` `priorHashFor` reads the whole log on a cold start — **not fixed**: it is
  recovery-only and once-per-execution, and a bounded tail read would need a new EventStore SPI
  method. The leak fix already bounds the cache. Documented, not worth SPI churn.)

**Vulnerabilities:**
- `audit-chain` `hmacMatches` — reject a signature that is not exactly 64 hex chars **before**
  `Buffer.from(sig,"hex")` (which silently truncates at the first invalid nibble). Prevents a
  malformed sig from comparing a short buffer.
- `audit-chain` `hashEvent` — **length-prefix** each field (`<len>:<prevHash>|<len>:<payload>`) so the
  boundary is unambiguous regardless of payload contents (belt-and-suspenders; JSON already escapes
  newlines, and `prevHash` is fixed-format hex).
- `orchestration` `childIdFor` — **reject a key containing `::`**, so `parentOf` (which peels the last
  separator) can't be tricked into resolving the wrong parent and misrouting a child's resume. (A
  nested parent id containing `::` is still fine — that is how nesting works.)
- `WorkflowRuntime` `recordExecutionDenied` — the comment claimed dedup that wasn't implemented.
  **Now really dedups**: if the tail is already an `EXECUTION_DENIED` for the same op+actor, record
  nothing more — bounding log growth from a flood of denied attempts (DoS). The throw still enforces
  every call.

## Rejected (with reason)

- **"Principal-less authz bypass" (flagged High).** This is the deliberate **trust-boundary model**,
  not a bug — the audit itself noted the code is correct. Forcing a throw when an authorizer is
  configured but no principal is present would break principal-less kernel-internal calls
  (TimerService, recovery). Instead, the `executionAuthorizer` dep doc now states the integrator's
  security contract explicitly (the edge MUST authenticate every external call).
- **splitmix64 "not crypto".** Correct and by design — `@loom/dst` is test-only; the PRNG is never
  used where crypto-randomness is required.
- Confirmed sound: timing-safe HMAC compare (length-guarded), canonicalize key-ordering & type
  distinction, genesis handling, no secret leakage, `foldState` gating, no prototype pollution in the
  new paths (the fold layer already guards `__proto__`).

## Verification

All existing tests green; added regression tests: malformed-sig rejection + terminal-eviction
transparency (`audit-chain`), separator-injection rejection (`orchestration`), denial-flood dedup
(`WorkflowRuntime`). Full build + typecheck + lint + suite green.
