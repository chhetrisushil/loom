# ADR 0145 — App-owned retention policy: one validated value the existing retention passes consume

- Status: **Accepted** (2026-11-02)
- Date: 2026-11-02
- Builds on: [ADR 0022](0022-k10-log-lifecycle-retention-redaction-encryption.md) (log lifecycle: retention,
  archive-before-delete), [ADR 0055](0055-k10-6-pin-seam-content-gc.md) (content GC),
  [ADR 0134](0134-snapshot-pruning.md) (snapshot pruning)
- Related: [ADR 0083](0083-second-consumer-rule.md) (second-consumer rule)
- Placement: **1P, `@loom/workflow-runtime` (the type, the validator, `LogLifecycle`) +
  `@loom/plugin-content` (`sweepUnpinnedContent`, structural) + `@loom/cli` (`--policy`).** No kernel change;
  KERNEL_ABI, EVENT_SCHEMA and every SPI version unchanged. No new `defineConfig` field.

## Context

Retention in loom is a set of explicit passes: `LogLifecycle.applyRetention` reclaims aged terminal
executions, `LogLifecycle.pruneSnapshots` drops superseded snapshots (ADR 0134), and `sweepUnpinnedContent`
erases unpinned blobs (ADR 0055). Nothing runs them on a timer; an operator, a cron job or the app's own
schedule calls them. Each pass took its own number: a `terminalTtlMs` argument, a `keepLatest` option, an
`olderThanMs` option, and the CLI took `--ttl` twice with different meanings (`loom retention run --ttl` is
the log TTL, `loom sweep content --ttl` is the content TTL). An app that wants "logs 90 days, content 90 days,
keep two snapshots" had to restate those numbers in every cron script and could not check that they agree. A content TTL
shorter than the log TTL is almost always a mistake, so the policy checks the relation (D2) - as an advisory
consistency check, not a guarantee (see D2).

Where the answer lives was settled by elimination:

- **`defineConfig`** - configuration says how the app is composed, not what an operator may destroy and when. A
  retention field there would also be read at composition time, by commands that never delete anything.
- **Middleware** - there is nothing to intercept. Retention is triggered by time passing after an execution
  ends, not by a step or an effect. A middleware that acted on it would need a timer, which is the hidden
  background thread loom refuses (every retention pass is explicit).
- **`policy$`** - an untyped declaration with no runtime consumer; nothing would read the value.

So the policy is a plain value the app keeps in its own module. Loom owns the type, the validator and the
consumers.

## Decisions

### D1 - The value

```ts
import { retentionPolicy } from "@loom/workflow-runtime";

export const retention = retentionPolicy({
  terminalTtlMs: 90 * 86_400_000,
  snapshots: { keepLatest: 2 },
  content: { unpinnedAfterMs: 90 * 86_400_000 },
});
```

`RetentionPolicy` keeps `terminalTtlMs` (required, unchanged in meaning) and gains two OPTIONAL sections,
`snapshots?: { keepLatest }` and `content?: { unpinnedAfterMs }`. The library API is milliseconds.
`retentionPolicy(spec)` validates and returns a deeply frozen copy; `assertRetentionPolicy(p)` only validates.
Both live in `packages/workflow-runtime/src/retentionPolicy.ts`; a violation is a `RetentionPolicyError`
(a `RangeError`) whose message names the field and the fix.

### D2 - The rules

- `terminalTtlMs`: a finite integer `>= 0`. `0` stays valid (every terminal execution is aged enough; the
  tests and `--ttl 0` rely on it).
- `snapshots.keepLatest`: an integer `>= 1`. There is deliberately **no age clock** on snapshots: a compacted
  execution's checkpoint snapshot IS its state, so "snapshots older than N days" would be a way to lose it.
- `content.unpinnedAfterMs`: a finite integer `> 0` and `>= terminalTtlMs`. This is an **advisory consistency
  check on the reclaimable-telemetry window, not a guarantee** that a kept log never names bytes that are gone.
  Per [ADR 0055](0055-k10-6-pin-seam-content-gc.md) (D4) only a claim-check envelope's own ref that the app
  marked `reclaimable` (claim-check config; readers tolerate it, `resolveClaimCheck` returns `null`) is
  TTL-reclaimable; retained blobs and bare refs are never TTL-reclaimed while cited. Per
  [ADR 0146](0146-content-age-from-execution-end.md) the sweep measures a terminal execution's citations from
  its END (never earlier than the citation), the same instant retention measures from
  ([ADR 0140](0140-agent-claim-check-opt-in.md) D6), so with this rule a reclaimable blob is never reclaimable
  before retention could delete the log (same policy, numeric timestamps). Exceptions, where the log lives on
  past eligibility while the blob is reclaimed: retention gates (pinned predicate, blocked-by-branch, unsupported, unsafe-archive) can keep the log longer; a running or re-opened execution keeps the citation clock; the retention archive's copy keeps citing forever; and a legacy log compacted before the terminal event was preserved is aged by retention from its last event while the sweep finds no terminal (citation clock). The rule is also checked **within one policy object only**: it holds when `loom retention run` and
  `loom sweep content` both use the same policy; a bare `--ttl` on either command, or a different policy file,
  is not compared.
- **Unknown keys are rejected**, at the top level and inside each section. A typo must not silently disable a
  rule.

### D3 - Every consumer re-validates

A TypeScript literal can skip `retentionPolicy()`, and a JavaScript caller or a CLI module can pass anything.
So every pass that RECEIVES a policy calls `assertRetentionPolicy` itself: `evaluate`, `applyRetention` and
`pruneSnapshots({ policy })`. It accepts every input that was valid before (`{ terminalTtlMs: 0 }` included).
`sweepUnpinnedContent({ policy })` cannot import the validator (no dependency on `@loom/workflow-runtime`), so
it re-validates **structurally** with its own copy of the rules: it reads each field once into a plain
snapshot, rejects unknown keys (top level and `content`), requires `unpinnedAfterMs` a finite integer `> 0`,
and, when `terminalTtlMs` is present, a finite integer `>= 0` with `unpinnedAfterMs >= terminalTtlMs`. It does
not check `snapshots` (the sweep reads nothing from it; a `snapshots` key is allowed, its contents are not
inspected). `retentionPolicy()` reads each input field exactly once, validates that snapshot, and freezes it,
so a getter that answers differently on a second read cannot smuggle a rule-breaking value;
`assertRetentionPolicy` stays an assertion, and the CLI uses the frozen snapshot, never the module's raw object.

### D4 - The consumers

- `LogLifecycle.evaluate` / `applyRetention` take the same parameter as before; the policy is a superset of it.
  Only `terminalTtlMs` is read.
- `LogLifecycle.pruneSnapshots(id, { policy })` takes `keepLatest` from `policy.snapshots`. An explicit
  `keepLatest` wins; a policy with no `snapshots` section changes nothing (the existing default of 1 applies).
  ADR 0134 D5 is unaffected: pruning decides nothing the content sweep reads.
- `sweepUnpinnedContent({ policy })` is an alternative to `olderThanMs`, taking
  `policy.content.unpinnedAfterMs`. The type is **structural** (`{ content?: { unpinnedAfterMs } }`), so
  `@loom/plugin-content` gains no dependency on `@loom/workflow-runtime`. Exactly one of `olderThanMs` /
  `policy` must be given; both or neither is a `TypeError`, and a policy with no `content` section is an
  error rather than a silent no-op. The orphan pass's guard margin (ADR 0055 D6) applies to the resolved
  value unchanged.

### D5 - The CLI

`loom retention run` and `loom sweep content` gain `--policy <module>`. The module is imported by path and
exports the value as the named export `retention` or as its default export (a CommonJS
`module.exports = { terminalTtlMs }` is the default export). If `retention` is present (even `null`) it is THE
export and is not skipped; a default export that is a loom app/config rather than a plain policy is refused
with a message to export `retention`. It is validated again through `retentionPolicy()`, and a broken policy
is a refusal (exit 2) that changes nothing. The module is loaded under the same `LOOM_NO_AUTOSTART` /
`LOOM_QUIET` guards and serialisation as `--config`, so a policy exported from `loom.config.ts` does not
start the app.

- `loom retention run --policy` reads `terminalTtlMs`. `--ttl` remains and **overrides** it; the combination
  is re-validated, so `--ttl 90d` against a shorter content TTL is refused. With neither flag the command
  refuses exactly as before: the destructive TTL is still never defaulted.
- `loom sweep content --policy` reads `content.unpinnedAfterMs`; `--ttl` overrides it (re-validated). A
  policy with no `content` section is **refused** (exit 2: add a `content` section or pass `--ttl`),
  matching the library, which throws for the same input; with `--ttl` alongside, `--ttl` is the value. Without
  `--policy` the 30-day default is unchanged.
- `loom retention run` does **not** act on `snapshots`. Pruning the snapshots of the executions it keeps would
  be a second destructive pass under a flag that today means "reclaim aged executions", with a dry-run story
  `pruneSnapshots` does not have (it reports a count only after deleting) and with refusals of its own
  (`BlankStreamUnrepairedError`). The section is validated and the report says it was not applied. Snapshot
  pruning stays a `LogLifecycle.pruneSnapshots` call (which does take the policy) until a snapshot-prune
  command is justified on its own.
  (Since [ADR 0134's 2026-11-02 amendment](0134-snapshot-pruning.md), `pruneSnapshots({ dryRun })` previews the
  count on a store with `listSequences`; the decision above, that `retention run` leaves snapshots alone, stands.)

### D6 - Opt-in, and absence changes nothing

With no policy supplied, every call, CLI command, default, stored byte and event is what it was: the same
signatures accept the same inputs with the same meaning, no `defineConfig` field is added, nothing is
scheduled, and snapshot pruning stays off unless asked. The one observable difference for an existing caller
is that an input that was never valid (a negative, fractional or non-finite `terminalTtlMs`) is now refused
instead of silently comparing. This includes `loom retention run --ttl` with a non-finite or unsafe value (a
400-digit number parses to `Infinity`): on main that kept everything and exited 0; now it is a refusal (exit 2,
a usage error), consistent with the `--policy` path. This is a deliberate change.

## Consequences

- An app states its retention once, in a module the type checker sees, and the cron job, the CLI and the app
  code read the same value; the log-TTL / content-TTL relation is checked in one place.
- `--policy` is a code-loading flag: the module runs with the operator's privileges, like `--config`.
- The CLI reads the policy through the same module loader as `--config` (CommonJS, ES module, and TypeScript
  through the project's own `tsx`).
- The policy carries no pins. `pinned`, `compactionExempt` and the content `pinnedEventTypes` stay
  `LogLifecycle` / sweep options: they are predicates and event kinds, not numbers, and the ADR 0055 pin seam
  is app code by design (G3).

## Deferred

- **Time-partitioned tables, or a write-time store decorator, for cheap expiry.** A store that partitions by
  time could drop a partition instead of scanning and deleting row by row, and a decorator could stamp expiry
  at write. Both change storage layout or the write path and need their own decision; this ADR changes
  neither.
- **Measuring reclaimable-telemetry age from execution end instead of from the latest citation.** It would make
  the D2 rule exact rather than advisory, but it changes every content sweep (ADR 0055/0140), so it is a
  separate decision.
- **A snapshot-prune command**, and `retention run` applying `snapshots` (D5).
- **A policy for the pre-existing pin predicates.** They stay options.

## Amendment (2026-11-03) - retention keeps an orchestration child while its parent is alive

Retention could delete a terminal orchestration child BEFORE its suspended parent collected the result. The
supervisor then had to tell "reclaimed" from "never started" (a re-run is unrecoverable), which it does by
remembering `EXECUTION_DELETED` facts in a bounded map and, after an eviction, rescanning the whole lifecycle
stream from sequence 0 for every absent child. This amendment adds PREVENTION in front of that and KEEPS the
rescan as the BACKSTOP (deletions made before the pin existed, deployments that do not wire it). It adds no
storage, no event, no SPI method and nothing on a hot path.

- **The pin.** `awaitedByParent(store, { snapshots?, onWarn? })` (`@loom/orchestration`) is a `PinPredicate`.
- **Which parent: the RECORDED one.** The parent is the `parent` on the child's own sequence 0 (written only
  under the kernel's lineage grant, so unforgeable; the edge `parkedOnChild` reads), NOT a split of the id: an app
  id `acct::42` is not a child of `acct`. No recorded parent (a root, an app id that merely contains `::`, a log
  from before R3k) means "not an orchestration child": not pinned here. An id with no `::` costs no read. The
  recorded parent is a logical id in the id space of the store the predicate is given (a tenant-scoped view
  un-prefixes both), so it is looked up as is.
- **The parent's state: newest lifecycle event wins, the re-open rule.** The parent's log is scanned from the tip
  backwards for the first event that says live or ended, by the rules of ADR 0146 `terminalEndOf`
  (`@loom/plugin-content`): `EXECUTION_RESUMED` / `SUSPENDED` / `STARTED` means LIVE (`resumeAs` re-opens a failed
  or completed execution by appending `RESUMED`, ADR 0104 D1 / 0110 D1, so an old `FAILED` below it does not
  release the child); `COMPLETED` / `FAILED` / `CANCELLED` or a kernel `EXECUTION_CONTINUED` means ended. Events
  that say neither (audit rows, late outcomes and rewards after the terminal event) are skipped.
- **Paging cap.** The scan reads backwards in pages of 16 events, at most 4 pages (64 events): normally 3 reads
  per candidate (child seq 0, parent `head`, one page), independent of log length. If no lifecycle event is found
  in 64 events and no covering checkpoint decides, the child stays PINNED and `onWarn` says so once per parent.
- **A continued parent (ADR 0109) is finished**, not pending: the supervisor cancels its non-detached children
  when it continues and nothing resumes the old generation, so its children are released.
- **A compacted parent** whose lifecycle events left the log is decided from its checkpoint, only when it covers
  the parent's tip (`snapshot.sequence >= head`) and reads terminal.
- **It fails safe, and says so.** When it cannot decide (a read throws, the cap is hit, no covering checkpoint)
  the child is PINNED: keeping a log is recoverable, a re-run of a deleted child is not. A read that throws (an
  encrypting store read without its keys, a sealed checkpoint) warns once per parent, because the effect is that
  retention stops reclaiming orchestration children for that run. The one exception is a crypto-shredded log
  (unreadable by design and forever): nothing can be waiting on it, so it pins nothing.
- **A continued CHILD keeps only the generations the head search can read.** A child that continues as new has
  generations `P::k`, `P::k~1`, `P::k~2`, ...; each records the same parent (a verified successor must).
  `followToHead` (ADR 0109 D4) finds the head with ONE exported search, `deepestGeneration`, which always starts at
  generation 0 (gallop `1, 3, 7, ...`, then bisection) and answers the generations the caller already saw without a
  read, so for a chain whose head is `H` it reads only `routeKeepSet(H)` = `{0}` plus the generations the search
  probes plus `H-1` (the head is accepted only as the verified successor of `H-1`): about `2*log2(H)` of them.
  `awaitedByParent` runs the SAME exported functions (no second copy of the rule): for a candidate generation `m` of
  a live parent's child it finds the head `D` with `deepestGeneration`, verifies it the way the kernel does
  (`isVerifiedSuccessor` from `D-1`, `sameLineage` with the original, nothing at `D+1`, newest lifecycle event not
  a kernel `EXECUTION_CONTINUED`) and keeps `m` iff `m >= D-1` or `routeKeepSet(D).has(m)`. A generation is needed
  over one contiguous run of heads and never again once released, so a decision made against an older, smaller head
  is still safe when the chain rotates. A perpetual child under a parked parent therefore holds `O(log H)` logs,
  not `H`. Any doubt keeps (and warns once per chain): a generation whose recorded number
  disagrees with its id, a search that crosses a deleted member (a pre-pin gap), a head that fails
  verification or has a successor, a throwing probe read. Three cases keep SILENTLY, because there is nothing to
  reason about and a warning would only add noise: the original id (always addressable), a chain whose root (generation 0) is missing, and a
  crypto-shredded log (unreadable by design and forever, as for any shredded log). The cheap, pure decision
  (`m >= D-1` or `routeKeepSet(D).has(m)`) runs FIRST, right after the head `D` is found, so a member of
  `K(D)` skips the verification and a doubt warning never names a generation that is kept anyway. Cost: `O(log D)`
  point reads per candidate generation, at retention time only. The kernel side adds no storage and no resume
  cost: a `running` head still makes one existence read (`g+1`), and one retry follows a failed head
  verification (a walk that read `H` and found `H-1` released after a rotation). Verification is unchanged, so a
  squatter or forged log is never routed to.
- **A busy head still releases.** The "newest lifecycle event is not a kernel CONTINUED" check scans a bounded
  tip (64 events). A head with more events than that since its newest lifecycle event (a child that rotates by
  event count is in that state most of each generation's life) is read as "not continued", not as a doubt. That
  is safe by proof (c) below: release safety needs only that `D` is a real generation that passed
  `isVerifiedSuccessor` and `sameLineage` (so the true head is `>= D`), not that `D` IS the head. Verification
  and the `D+1`-absent check stay.

  **Proofs** (the head search is `deepestGeneration` / `routeKeepSet` in `@loom/workflow-runtime`; they hold
  for every head `H <= 2^31 - 2`, the bound of the search's `step < 2^30` guard).

  *Notation.* The search gallops from `lo = 0`, `step = 1`: while `step < 2^30` and the probe at `lo + step`
  answers yes, `lo += step` and `step *= 2`. Then `hi = lo + step` and it bisects with
  `mid = lo + floor((hi - lo) / 2)`. `&&` short-circuits, so nothing is probed once the guard fails.
  `Oracle_H(q)` is `[q <= H]`; `E(H)` is the set of probes answered yes under `Oracle_H`;
  `K(H) = routeKeepSet(H) = {0, H, H-1} U E(H)`. `N = H + 1`, `trunc_t(x) = floor(x / 2^t) * 2^t`.

  *Lemma 1 (gallop).* After `i` yes-answers `lo = 2^i - 1` and `step = 2^i`; the next probe `2^(i+1) - 1` answers
  yes iff `2^(i+1) <= N`. Let `j = floor(log2 N)`. If `j < 30` the gallop stops on a no at `2^(j+1) - 1 > H`, so
  `hi = 2^(j+1) - 1 > H`. If `j = 30`, after 30 yes-answers `step = 2^30`, the guard fails, `hi = 2^31 - 1` is
  never probed, and `hi > H` still holds because `N < 2^31`. Either way `lo = 2^j - 1 <= H < hi` and
  `hi - lo = 2^j`.

  *Lemma 2 (bisection).* Let `r = H - (2^j - 1) = N - 2^j`, so `0 <= r < 2^j`. Invariant: when `hi - lo = 2^k`,
  `lo = 2^j - 1 + trunc_k(r)` (true at `k = j`, since `trunc_j(r) = 0`). The midpoint `lo + 2^(k-1)` is `<= H` iff
  bit `k-1` of `r` is set, and in both cases the new `lo = 2^j - 1 + trunc_(k-1)(r)`. At `k = 0`, `lo = H`. So
  the search returns `H` for every `H <= 2^31 - 2`.

  *Closed form.* The yes-probes are the gallop points `{2^i - 1 : 1 <= i <= j}` and
  `{2^j - 1 + trunc_t(r) : bit t of r is set}`. Since `{trunc_t(r) : t set} U {0} = {trunc_t(r) : 0 <= t <= j}`
  and `2^j + trunc_t(r) = trunc_t(N)` for `t <= j`: `m` is in `K(H)` iff `m = H-1`, or `m+1` is a power of two
  `<= N`, or `m+1 = trunc_t(N)` for some `t` with `trunc_t(N) > 0` (or `m = 0`). A generation `m` with `m+1` a
  power of two is kept forever (the gallop spine, about `log2 H` generations); any other `m` is kept for the
  heads with `H+1` in `[m+1, m+2^v2(m+1)]` (`v2` = trailing zero bits), plus `H = m+1`. `|K(H)|` is at most
  `2*log2(H) + 2`.

  *(a) Search correctness.* Take any `known <= H`, a store holding exactly `K(H)` and nothing above `H`.
  (1) A probe `q <= known` is answered yes WITHOUT a read, which equals `Oracle_H(q)` because `q <= known <= H`.
  (2) A probe `q > known` is read. If the run so far matches the `Oracle_H` run: `q <= H` means `q` is a
  yes-probe of that run, so `q` is in `E(H)`, hence in `K(H)`, hence present, so the read says yes; `q > H` is
  absent, so the read says no. (3) By induction the run IS the `Oracle_H` run: it returns `H` (Lemma 2), reads no
  generation `<= H` outside `E(H)`, and its reads above `H` are of absent ids. (4) Verification reads `H` and
  `H-1`, both in `K(H)` (`H-1 = 0` is read as the chain id). The kernel's `known` is always (the addressed
  generation `g`) + 1: `g+1` was created by the kernel and heads never decrease, so `g+1 <= H` even if `g+1` has
  since been reclaimed (the shortcut answers it without a read, which is why survivors still reach the head).

  *(b) Monotonicity.* `m <= D <= H'` and `m` in `K(H')` imply `m` in `K(D)`. Let `n = m+1`, `M = D+1`,
  `N' = H'+1`, so `n <= M <= N'`. If `m = H'-1`, then `D` is `m` (`m` is `D`'s head) or `m+1` (`m = D-1`); either
  way `m` is in `K(D)`. If `n` is a power of two `<= N'`, then `n <= M` puts `n` in `K(D)` by the same clause. If
  `n = trunc_t(N')`: `trunc_t` is non-decreasing, so `n = trunc_t(n) <= trunc_t(M) <= trunc_t(N') = n`, hence
  `trunc_t(M) = n` and `m` is in `K(D)`. (`m = 0` is in every `K`.) The closed form needs `H' <= 2^31 - 2`.

  *(c) Release safety.* Invariant `I(t)`: every member of `K(H(t))` is present, `H(t)` being the true head,
  which never decreases. Base: a chain is created contiguously. Rotation `H -> H+1`: by (b) with `D = H`, every
  member of `K(H+1)` except `H+1` is in `K(H)`, so already present. Pin release: `m` is released only if
  `m < D-1` and `m` is not in `K(D)`, where `D` is a present generation that passed `isVerifiedSuccessor` and
  `sameLineage`. `x~digits` ids are created only by the kernel's `startSuccessor`; `assertCreatable` and
  `restoreFromState` refuse them for every caller and a continued member cannot be resumed. So `D` existing
  means `H(t) >= D` at the read and at every later time, including the deletion time. By the contrapositive of
  (b), `m` not in `K(D)` with `m <= D` gives `m` not in `K(H')` for every `H' >= D`, in particular the head at
  deletion time. The invariant therefore survives any interleaving: rotations in the middle of a pass,
  concurrent passes, evaluate-then-apply. Release safety needs only "`D` is a real generation `<=` head", not
  "`D` is the head"; the other checks (`D+1` absent, newest lifecycle event not CONTINUED, and `m >= D-1`, which
  is redundant since `D-1, D` are in `K(D)`) are defence in depth for chains with pre-existing gaps.

  *Beyond `H = 2^31 - 2`.* (a) and (b) are not claimed: the search returns `2^31 - 2` for a longer chain, the
  kernel then steps the verified links the rest of the way (as it always could), and the pin keeps everything,
  because its `D+1`-absent check fails.

  **Residuals (accepted).** (1) A squatter planted at `H+1` of a chain whose intermediates were reclaimed fails
  verification, so it is never routed to or trusted; the cost is liveness only (the supervisor reads such a
  chain as "running"). (2) Retention over a raw, tenant-prefixed PHYSICAL store sees physical ids, so a child id
  differs from `successorIdOf(logical chain)`: the pin keeps the generation and warns once per chain (fails safe,
  noisy). Run retention over the logical store. (3) The chain analytics in `@loom/analytics` show the
  reclaimed generations as gaps; that is the intended view of a bounded history, not a loss of the chain.
- **Where it is wired, on by default.** `defineConfig` ORs it into `app.lifecycle`'s `pinned` (after the app's
  own `durability.retention.pinned`, never replacing it) whether or not `app.supervise` was called, and
  `loom retention run` passes it to its `LogLifecycle`. `LogLifecycle.evaluate` reports such a child as
  `"pinned"`, so the dry run matches the run. The ADR 0118 D3 `pinParkedChildren` stays: it is exact (the parent
  is parked on THIS child) but needs a registered supervisor and two folds; `awaitedByParent` is coarser (a live
  parent keeps all its children) and store-only. `loom repair` builds a `LogLifecycle` that never runs
  `applyRetention`, so it needs no pin.
- **Observable change.** Terminal children of a still-live parent are kept longer than `terminalTtlMs`, until the
  parent ends. With no orchestration nothing changes.

Not changed: the `LogLifecycle` re-home pass reads the lifecycle stream once per operator pass (to find
already-journaled `EVENTS_REHOMED` facts). It is per pass, not per fact, and a bounded read of it would need a
persisted cursor, which is new storage; left as is.
