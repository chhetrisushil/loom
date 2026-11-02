# ADR 0145 — App-owned retention policy: one validated value the existing retention passes consume

- Status: **Proposed** (2026-11-02)
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
keep two snapshots" had to restate those numbers in every cron script and could not check that they agree. They
must: a content TTL shorter than the log TTL leaves a kept log naming bytes that are gone.

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
- `content.unpinnedAfterMs`: a finite integer `> 0` and `>= terminalTtlMs`. Content must outlive the logs
  that cite it.
- **Unknown keys are rejected**, at the top level and inside each section. A typo must not silently disable a
  rule.

### D3 - Every consumer re-validates

A TypeScript literal can skip `retentionPolicy()`, and a JavaScript caller or a CLI module can pass anything.
So every pass that RECEIVES a policy calls `assertRetentionPolicy` itself: `evaluate`, `applyRetention` and
`pruneSnapshots({ policy })`. It accepts every input that was valid before (`{ terminalTtlMs: 0 }` included).

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
exports the value as the named export `retention` or as its default export; it is validated again with
`assertRetentionPolicy`, and a broken policy is a refusal (exit 2) that changes nothing.

- `loom retention run --policy` reads `terminalTtlMs`. `--ttl` remains and **overrides** it; the combination
  is re-validated, so `--ttl 90d` against a shorter content TTL is refused. With neither flag the command
  refuses exactly as before: the destructive TTL is still never defaulted.
- `loom sweep content --policy` reads `content.unpinnedAfterMs`; `--ttl` overrides it (re-validated). A
  policy with no `content` section leaves the existing 30-day default in place.
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
instead of silently comparing.

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
- **A snapshot-prune command**, and `retention run` applying `snapshots` (D5).
- **A policy for the pre-existing pin predicates.** They stay options.
