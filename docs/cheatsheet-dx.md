# Cheatsheet — working with Loom

> Card II of two. The command line, the scaffolds, the tests, and the operator passes — plus
> the handful of things that reliably bite. Every writing command is a dry run until
> `--apply`. Card I is [what the kernel gives you](cheatsheet-features.md).
>
> **19** plugin seams · **19** conformance kits (`loom plugin seams` shows which seams have one) ·
> every log command takes `--config` or `--db` (`knowledge`, `verify`, `deploy check` are `--config` only)

## Day one

```bash
# unpublished: build a loom checkout once (pnpm install && pnpm build), then
node <loom>/tools/create-loom-app/dist/index.js my-app --loom-path <loom>
cd my-app && pnpm install && pnpm test && pnpm start

loom new flow checkout      # scaffold a definition (+ its flow.test.ts)
loom gen                    # regenerate loom.gen.ts
loom doctor                 # what can I check right now?
```

Outside the checkout `--loom-path` is required (`create-loom-app` refuses without it); inside it
(`<loom>/apps/my-app`) no flag is needed. `loom new` names are kebab-case; a kind that imports a
package your `package.json` lacks (`sentinel`) prints the line to add. `loom new` takes `flow · agent · tool · skill · schedule · memory · projection · sentinel`.
The folder convention is **build-time** codegen — a static `loom.gen.ts`, never runtime
globbing.

## `<store>` — where a command reads

Both halves work for every log command; `knowledge`, `verify` and `deploy check` need `--config`.

| | |
|---|---|
| `--config ./dist/app.js` | the stores **your app** wired — SQLite, Postgres, or any conforming backend. Importing it starts nothing. |
| `--db events.db [--snap] [--branches] [--leases]` | SQLite shorthand, one file per store. A flag you omit is a store the command cannot consult — and it says so rather than reporting zero. |

> **Leases and placement exist because you run more than one node** — and a multi-node
> deployment is not a file you can pass to `--db`. Use `--config` for anything real.

## Before you ship

| | |
|---|---|
| `loom doctor [--config m]` | runs every pre-flight check it can, and names the ones it could not — timers, lease scope (`process`/`host`/`cluster`), plaintext snapshots under encrypting events, archive safety |
| `loom check` | static flow-graph checks from the compiler manifest |
| `loom verify` | runtime verification against a built config |
| `loom lint claim-check` | flags claim-check reach-through inside flows |
| `loom eval` | replay golden logs against expectations |
| `loom deploy check` | simulate a deploy against new flow definitions |
| `loom compat` | validate ABI / event-schema versions |
| `loom kernel-manifest` | kernel version + maturity manifest |

### Reading doctor's four marks

| mark | meaning | fails the run? |
|---|---|---|
| `✓` | ran, and passed | no |
| `✗` | ran, and found a defect | **yes** (exit 1) |
| `–` | **skipped** — the input it needs was not there | no |
| `!` | **advisory** — it ran, and whether the finding matters depends on how you deploy | no |

`all checks passed` and `passed, but 2 could not run` are deliberately different sentences.

## Inspecting a run — read-only

| | |
|---|---|
| `loom logs <store> <id>` | the event timeline (`--redact a,b`) |
| `loom debug <store> <id> --at N` | folded state at sequence N — time travel |
| `loom inspect <store>` | web timeline with a slider |
| `loom profile <store> <id>` | flame graph + latency breakdown |
| `loom introspect <store> <id>` | execution / task / decision / resource graphs |
| `loom optimize <store> <id>` | advisory recommendations |
| `loom learn report\|eval` | trajectories, coverage, shadow-evaluate a policy |
| `loom census <store>` | what is stuck, and is anything watching it |
| `loom compliance report` | data-subject inventory |
| `loom knowledge list\|search` | what a corpus holds; ask it |

## Operating it — writes, dry by default

| | |
|---|---|
| `loom recover <store> [--stale 15m] [--apply]` | re-drive executions whose supervisor died. Needs `timers.leases` **or** an explicit `--stale` — loom will not guess. `--apply` requires `--config`, because re-driving runs your flow. `--max-recoveries N` skips and lists executions whose last N re-drives made no progress (ADR 0105). |
| `loom repair blank-stream <store> [--assign id:from-through] [--apply]` | re-home events the pre-0106 compaction bug wrote to execution `""` — proven segments only; the rest is listed with candidates, never guessed (ADR 0107) |
| `loom retention run <store> [--ttl ms] [--apply]` | reclaim aged terminal executions. Without a branchRegistry the live-descendant guard is **off**. |
| `loom repair terminal-event <store> [id] [--apply]` | give an execution a pre-0116 compaction left as `[0]+checkpoint` its terminal event back, so it can take a late outcome (ADR 0116) |
| `loom branches retire --parent <id> --stale <d>` | cancel branches nobody is coming back to — they keep the parent uncollectable |
| `loom branches prune [--protect main]` | delete refs that name nothing; `main` is protected |
| `loom sweep content --content <db>` | pinned-blob sweep over externalized payloads. `--orphans` also erases blobs nothing scanned cites — it needs the snapshot store and every archive; dry-run first |
| `loom knowledge sync --apply` | reconcile a directory into a corpus (also **removes**) |

> **Heartbeat leases (ADR 0130 D11) are the default evidence** that a driver is gone: with a
> co-located lease store the sweep re-drives an execution whose lease *expired*, and refuses one
> whose lease is live. Details: [operations](operations.md#3-failure-recovery).

> **The preview is the pass.** Each dry run is the same code path as `--apply`, so it cannot
> promise an outcome the real run won't deliver — and it claims no lease while looking.

## Testing — `@loom/testing`

| | |
|---|---|
| `createTestApp(config?)` | in-memory app; storage defaults to memory |
| `driveToSuspend(handle)` | start → first suspend |
| `resumeWith(runtime, id, ev?)` | resume sugar |
| `waitFor` / `waitForPhase` | poll a predicate or a surface phase |
| `getSurfaceState` | read a surface |
| `captureGolden(store, id)` | freeze a log as a fixture |
| `recordingProvider` / `replayingProvider` | VCR for LLMs: record once, replay offline |
| `crashingEventStore` | inject a store failure — prove recovery, don't assume it |
| `@loom/dst` | deterministic simulation: `simWorld`, `faultInjectingStore`, `virtualClock`, seeded fault schedules checked against `INVARIANTS` |

Rules the repo enforces on tests: wait on a *condition*, never a fixed `sleep`; no
`performance.now()` or timing ratios in `*.test.ts` (put them in `*.perf.test.ts`, run with
`pnpm test:perf`); bind test servers to `127.0.0.1`, never a bare `listen(0)`.

## Authoring a plugin

```bash
loom plugin seams              # 19 seams, and how each is wired
loom plugin new lease my-redis
loom plugin check --publish    # npm-readiness too
loom plugin try --module ./dist/index.js
loom plugin search <term>
```

Seams: `store` · `dispatcher` · `telemetry` · `middleware` · `timer` · `lease` · `content` ·
`durable-state` · `read-model` · `keystore` · `memory` · `projection` · `worker` · `llm` ·
`authorizer` · `execution-authorizer` · `resume-authenticator` · `timer-dispatcher` ·
`policy`.

> **Run the conformance kit.** Every seam with one ships `run<Spi>Conformance(factory)` — it
> covers the concurrent cases (two owners racing, re-apply, renewal after expiry) that
> hand-written tests miss.

## Generating an app from intent

```bash
loom appgen "<intent>" [--dir .] [--dry-run] [--check]
loom appgen --from-spec .loom/appgen/<ts>.spec.json   # replay, no model
```

Deterministic and offline in the output: no model call at generate time, and none in the
generated app.

## Things that bite

- **A package's tests import its siblings' `dist`.** Edit a dependency's `src` and nothing
  changes until you rebuild it — sourcemaps will point at pre-edit line numbers.
- **`pnpm typecheck` does not see tests.** Package `tsconfig`s exclude them, so a type-level
  proof in a test proves nothing until `pnpm typecheck:tests` (build first) runs it.
- **Inner loop:** `pnpm build:fast` (one `tsc` process) and `pnpm test:src` (siblings resolved to
  source). Before a PR: `pnpm build && npx turbo test --force --concurrency=2 && pnpm typecheck
  && pnpm typecheck:tests && pnpm lint`. CI runs only on *ready* PRs — open drafts.
- **`tsc --build` trusts `.tsbuildinfo`.** Delete `dist` and it may rebuild nothing; use
  `--force`.
- **Three rules see past declared steps only with a compiler manifest.** Without one,
  `loom verify` says so rather than reporting clean.
- **`needsApproval: true` parks** the tool call; the deprecated `requireApproval: true` meant
  *proceed*. Same log, opposite polarity — rename, don't just alias.
- **A strict resume schema changes what is persisted.** `z.object` drops unnamed keys from the
  log for good; `agentLoop$` approvals need `viewDigest` to pass through.
- **Grouped config options throw when spelled flat** — there is no deprecation window.
- **Global install ≠ `pnpm link`.** pnpm's global store is tied to its major version, and
  this repo pins one via `packageManager`.
