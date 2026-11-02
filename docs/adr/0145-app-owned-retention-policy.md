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
