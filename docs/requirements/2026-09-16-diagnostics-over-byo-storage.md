# Diagnostics over BYO storage: the operator surface only runs on SQLite

**Status:** **SHIPPED** — S1–S5 all landed. D1 decided and implemented (`autostart: false`).
Two things were learned in the building and are recorded in §8.
**Date:** 2026-09-16
**Kernel baseline:** EVENT_SCHEMA 1.18.0, KERNEL_ABI 1.1.0, EventStore SPI 1.4.0, BranchRegistry SPI 1.2.0, LeaseStore SPI 1.1.0
**Kernel change:** none. The work is `@loom/app` (composition) + `tools/cli` (resolution).

---

## 0. The finding

Ten files under `tools/cli/src` construct `SqliteEventStore` (and friends) directly:

| file | commands | construction sites |
|---|---|---|
| `census.ts` | `loom census` | 4 |
| `retention.ts` | `loom retention preview\|run` | 5 |
| `commands.ts` | `loom logs`, `loom debug` | 3 |
| `sweepContent.ts` | `loom sweep content` | 3 |
| `compliance.ts` | `loom compliance report` | 2 |
| `introspect.ts` | `loom introspect` | 2 |
| `optimize.ts` | `loom optimize` | 2 |
| `profile.ts` | `loom profile` | 2 |
| `learn.ts` | `loom learn` | 2 |
| `cli.ts` | flag plumbing | — |

The CLI has **no Postgres dependency at all** — not an unused one. So every operator-facing
diagnostic loom ships runs against exactly one backend, and it is the single-node one.

That inverts the features these commands exist to serve:

- **Leases (ADR: #380) exist because more than one node runs executions.** More than one node
  means Postgres — `SqliteLeaseStore`'s own header says so: *"Single-host by nature… Multi-node
  wants Postgres."* So `loom census --leases`, whose entire purpose is measuring the orphan population
  that #408 deferred, **cannot run in the deployment where orphans occur.**
- **Placement (#392) exists because executions run on different compute.** `placementOf` reads
  sequence 0 from an EventStore the CLI can only open if it is a local file.
- **Retention's live-descendant guard (R5.3)** needs a `BranchRegistry`. On a multi-node
  deployment there is no `--branches` path to pass.

This is the same shape as every other finding this week — a capability that exists and is not
reachable — one level up: not an unreachable function, an unreachable *deployment*.

## 1. Why the obvious fix is the wrong one

The first instinct was to let `--db` accept a connection string and sniff the scheme:

```sh
loom census --db postgres://loom@db.internal/loom   # rejected
```

It is wrong on loom's own terms. `defineConfig` takes `storage: { kind: "custom", eventStore,
snapshotStore, branchRegistry }`, ADR 0043 makes 1P and 3P backends symmetric, and the
conformance kits exist so a third-party store is a *first-class* store. A CLI that recognises
`postgres://` and a file path blesses exactly two backends and leaves every conforming store —
a 3P DynamoDB EventStore, an in-house one, `loom-plugin-vector`'s neighbours — unreachable by
every diagnostic. The scheme sniff does not generalise; it just moves the wall.

The generic answer is not *more backends the CLI knows about*. It is **the CLI knowing none of
them**, and asking the application.

## 2. The design: resolve storage from the composition

The convention already exists in this CLI. `loom verify --config <module>` loads the module and
takes `mod.default ?? mod.app ?? mod` as a `LoomApp` (`verify.ts:120`). The storage-touching
commands simply never adopted it.

```sh
loom census      --config ./dist/app.js              # your stores, whatever they are
loom retention run --config ./dist/app.js --apply
loom logs        --config ./dist/app.js --execution checkout-42

loom census --db ./.data/events.db --leases ./.data/leases.db   # shorthand, unchanged
```

Two consequences worth stating:

1. **BYO is served by construction, not by enumeration.** A backend that passes the conformance
   kit is a backend the diagnostics run on, with no CLI change and no entry in any table.
2. **Several flags stop existing rather than being forgettable.** `--snap`, `--branches` and
   `--leases` exist only because the SQLite shorthand spreads one deployment across several
   files. From a config, retention's R5.3 guard is wired because the app wired it — the footgun
   patched yesterday with a `⚠ no --branches given` warning cannot occur on this path.

`--db` stays. A local SQLite file with no build step is the right front door for development,
and it is how every existing invocation is spelled.

## 3. Three things block it today

### B1 — `LoomStores` does not carry what the diagnostics need

```ts
export interface LoomStores {
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  branchRegistry?: BranchRegistry;
  memoryStore?: MemoryStore;   // present only when CONFIGURED — absence is the signal
}
```

Missing: the **timer store** (configured at `timers.store`, never surfaced) and a **lease
store**. So `loom census --config` would read events and snapshots and then be unable to answer
the lease-coverage question that is the command's entire reason to exist.

### B2 — there is no lease seam in `defineConfig`, and that is not a CLI problem

`timers` takes `{ store, pollMs, schedules, fenced, warmLeadMs, dispatcher }` — no `leases`.
`defineConfig` constructs the `TimerService` itself (`defineConfig.ts:897`) and forwards every
one of those options; an app cannot pass a `LeaseStore` because there is nowhere to declare one.

The CLI is the *smaller* half of this. Two facts found while checking whether the seam is
actually required:

- **Nothing in the repository wires `leases:` into a `TimerService` outside tests.** The only
  non-test occurrences are the census's own option shape and the CLI flag that feeds it. The
  leased-wake path shipped with #380 — claim before waking, skip without completing the timer
  when the claim is lost — therefore has **no reachable entry point** from the framework's own
  front door. That is the vacuous pattern again, and it is mine.
- **The user guide teaches the fallible form and then recommends the unreachable one.**
  `docs/user-guide.md:1662` composes recovery out of `defineConfig` (`app.runtime`,
  `app.stores.eventStore`) with a staleness predicate, and closes with: *"Prefer a real liveness
  signal from your orchestrator over a timeout where you have one."* A lease **is** that signal,
  and it is precisely what an app assembled that way cannot supply.

`app.runtime` is exposed, so an application can hand-build a second `TimerService` with leases —
but `defineConfig` has already started an unleased one against the same store, so that is a
hazard (two pollers, one of them unclaimed), not an escape hatch.

So the seam is required twice over: the diagnostics need the composition to carry a lease store,
and — independently of this document — the runtime capability is unreachable without it. The
alternative for the CLI alone would be a `--leases <path>` flag, which is a SQLite-only spelling
of exactly the wall §1 rejects.

### B3 — importing a config *starts* things

`defineConfig` calls `timerService.start()` (`defineConfig.ts:904`). A read-only `loom census
--config ./dist/app.js` would therefore start a polling timer service against production
storage and **fire due timers and cron occurrences** as a side effect of being inspected.

A diagnostic with side effects is worse than a missing diagnostic. This one cannot be solved by
the CLI being careful — the side effect happens during `import`, before any CLI code runs. It
needs the composition root to support being built without being started.

This is the load-bearing decision in the whole document (§6, D1).

## 4. What the diagnostics may assume about a store

Today the SQLite classes satisfy every optional capability, so no caller has ever had to
degrade. Over BYO storage that stops being true: `listExecutions`/paging, `head`, `deleteExecution`,
`removeLineage`, `LeaseStore.get` are each optional or store-specific.

**Rule.** A diagnostic that needs an optional capability must name it and refuse:

```
loom census needs to enumerate executions, and the configured EventStore
(MyDynamoEventStore) does not implement listExecutions.
```

Not a stack trace, and — the rule that keeps recurring this week — not a zero. `orphanCensus`
already omits lease fields rather than reporting `0` when no lease store was given; the same
discipline generalises to every capability a store may not have.

## 5. Staging

Each stage is a branch and a PR, in order. S1 and S2 are `@loom/app`; S3–S5 are the CLI.

| | stage | shape | verification |
|---|---|---|---|
| **S1** | Build-without-start seam (§6 D1) | `@loom/app` | a config whose `timers.schedules` contains an already-due occurrence is imported by the CLI path; assert the log is untouched and `TimerService` never polled |
| **S2** | Expose stores + the lease seam | `LoomStores.timerStore?`/`leaseStore?`, `timers.leases` | round-trip test: an app that configures a lease store exposes the SAME instance; an app that does not exposes `undefined` (absent ≠ empty). Plus: a `defineConfig`-composed app takes a leased timer wake — the assertion that has no caller today. Ships with the `docs/user-guide.md:1662` correction, since that passage recommends a signal it cannot reach |
| **S3** | `resolveStores()` + `census`/`retention` | `tools/cli` | both commands run against a `kind: "custom"` config wired to a **non-SQLite** store — the in-memory stores are the cheapest proof that nothing SQLite-shaped is assumed |
| **S4** | Remaining eight commands | `tools/cli` | mechanical; each keeps its `--db` path green |
| **S5** | Docs + guard | `docs/usage-cli.md`, fitness test | a test asserting no file in `tools/cli/src` imports `@loom/plugin-sqlite` outside the `--db` shorthand resolver |

S5's guard is the point of the exercise: without it, the next command added goes straight back
to `new SqliteEventStore(...)`, because that is what every neighbouring file does. The defect
class is *regenerated by its surroundings* — the same reason a swept defect needs its generator
fixed rather than its instances.

## 6. Decisions to make before S1

**D1 — how "build but do not start" is expressed. DECIDED: `autostart: false`.** Three
candidates were on the table:

- `defineConfig({ ..., autostart: false })` — smallest diff; adds a mode flag to a config object
  that so far describes a *deployment*, not a lifecycle.
- The config module exports a factory (`export function createApp()`), with the CLI calling it.
  No new API, but it is a convention the CLI must document and cannot enforce, and it breaks
  every config that today default-exports the app — including the one `loom verify` expects.
- `app.stores` is populated eagerly while everything with a lifecycle (timers, schedules,
  subscriptions) starts lazily on first use. The cleanest semantics and the largest change.

**Chosen: `autostart: false`** — the only one that can be added without invalidating an existing
config module, and `loom verify` has already fixed the export shape. The lazy-lifecycle option is
the better end state and stays available later; it is not worth blocking S1 on.

**D2 — does `--config` have to be built JS?** Yes, and it already is for `verify`/`deploy check`.
Worth stating in the docs rather than discovering at the prompt.

**D3 — does the SQLite shorthand keep `--snap`/`--branches`/`--leases`?** Yes, unchanged. The
shorthand's whole justification is a dev machine with loose files.

## 7. Placement verdict (ADR 0083)

Not kernel — no syscall, no event, no SPI version bump. S1/S2 are `@loom/app`, the composition
root, which is exactly where "what did this deployment wire" belongs. S3–S5 are the CLI.

Second consumer for the `leases` seam is already on the table and unrelated to the CLI:
`TimerService` (ownership before a wake) and `recoverAbandoned` (ownership before a re-drive)
are two live consumers that today can only be reached by hand-building the runtime.

---

## 8. What the plan did not predict

**The seam needed an environment variable.** §3/B3 established that a config module must be
loadable without starting, and D1 chose `autostart: false`. But the operator running
`loom census --config ./dist/app.js` **cannot edit that module**, and the start happens while
it is being imported — before any CLI code runs. So `autostart` alone would have solved the
problem only for apps that had already anticipated being inspected. `resolveStores` sets
`LOOM_NO_AUTOSTART=1` before the import; `defineConfig` honours it, and *says so* when it
overrides an explicit `autostart: true`, because that is the one way this could quietly stop
timers in production.

**The built CLI is a different program from its test suite.** `--config` passed its entire
unit suite and then failed on the first line of the real binary: this package compiles to
CommonJS, where `tsc` downlevels `import()` to `require()`, which cannot load ESM or a
`file://` URL at all. Vitest runs TypeScript through an ESM pipeline and never sees it.

The fix is a loader that tries `require` (the shape `loom verify` has always assumed) and
falls back to a genuine dynamic import for ESM — including top-level await, which
`require(esm)` refuses even on Node 22+. The lasting part is `builtCli.test.ts`, which runs
**the artifact**: it is the only test here that could have caught this, and the defect class
it guards — "the thing we ship behaves differently from the thing we test" — is invisible to
every other kind of coverage.

`loom verify` has the same latent limitation (a bare `require`, so an ESM config module fails
there too). Not fixed here: it is a separate command with its own callers, and bundling the
change would hide it. Worth a follow-up issue.