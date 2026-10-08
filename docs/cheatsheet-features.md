# Cheatsheet — what Loom gives you

> Card I of two. The durable-execution kernel: ten syscalls, the builders that declare work,
> and the subsystems layered on the log. Everything here survives a process dying mid-step.
> Card II is [the developer workflow](cheatsheet-dx.md).
>
> KERNEL ABI **1.3.0** · EVENT SCHEMA **1.23.0** · EventStore SPI **2.2.0** ·
> BranchRegistry SPI **2.0.0** · LeaseStore SPI **2.1.0** · MemoryStore SPI **2.1.0**

## The ten syscalls

Everything else is built from these.

| | |
|---|---|
| `ctx.execute` | run any task to durable completion — the general primitive |
| `ctx.run` | run a declared step; the `step` alias of execute |
| `ctx.decide` | record an advisory choice; served from the log on replay |
| `ctx.parallel` | run tasks concurrently, input order preserved; with `kernel.features.scopes` a cancellation scope (fail-fast aborts siblings) |
| `ctx.suspend` | pause until an external signal, then resume *here* |
| `ctx.sleep` | pause for a duration; the wake is a logged `TIMER_FIRED` |
| `ctx.sleepUntil` | pause until an absolute time recorded in the log |
| `ctx.receive` | wait for the next message on this execution's durable inbox (`runtime.send`, ADR 0110); consumption is recorded, delivered tainted; needs `kernel.features.inbox` |
| `ctx.select` | wait for the first of several gates, inbox topics and timers (ADR 0110); the first answered arm settles it; needs `kernel.features.inbox` |
| `ctx.continueAsNew` | end this execution and start its successor `<chainId>~<n>` with a carry; never returns; bounds the fold, the snapshot and the per-turn cost of a long-lived loop (ADR 0109); needs `kernel.features.continueAsNew` |
| `ctx.emit` | append a durable domain event — once per execution; a re-run serves it from the log |
| `ctx.stream` | emit an incremental delta event (once per execution, like `emit`) |
| `ctx.ui` | **deprecated** (ADR 0114): drive durable, replayable UI surfaces — injected accessor; new code uses `surface(ctx)` from `@loom/agent-surface` |
| `ctx.negotiateBudget` | negotiate a resource budget against a ceiling, recorded once (ADR 0032) |

> **Nothing else is durable.** A bare `await fetch()` in a runner re-runs on replay and is
> never recorded. If an outcome matters, it goes through a syscall.

## Declaring work — `@loom/core`

| | |
|---|---|
| `flow$` | a durable workflow: id, version, schemas, steps |
| `step$` | one unit of work, bound to a `toolId` |
| `tool$` | the effect a step invokes |
| `agent$` | a model-driven actor with tools and memory |
| `skill$` | offline, deterministic capability selection |
| `schedule$` | cron occurrence — fires only if a TimerStore is wired |
| `memory$` | a scoped, bounded agent memory |
| `projection$` | fold events into read state |
| `policy$` | app-global rule, composed under the authorizer |
| `handler$` | extractable handler body (compiler) |
| `instructions$` | prompt material as a declared value |
| `agentLoop$` (canonical) / `agentStep$` (deprecated) | ReAct loop, one frame per turn / single opaque agent step — `@loom/agent` |

## Composition — `defineConfig`

Options are **grouped**; flat spellings throw, with no deprecation window.

```ts
defineConfig({
  storage: { kind: "custom", eventStore, snapshotStore },
  timers:  { store, leases, dispatcher, schedules },
  autostart: false,        // build, don't run
  security:      { … },    // the three rings
  observability: { … },    // onEvent, telemetry, onWarn
  durability:    { … },    // snapshots, retention
  execution:     { … },    // dispatcher, middleware, clock
  checks:        { … },    // boot-time validation
})
```

> `autostart: false` builds the app without starting its timer service — what an operator
> command needs so that *inspecting* a deployment never fires its schedules. `app.start()`
> is the other half.

## Time and waiting

| | |
|---|---|
| `suspend({ on })` | wait for a named gate; resume by event type |
| `suspend({ timeout })` | needs a `TimerStore`, or it never wakes |
| `resumeSchemas` | parse a resume payload *before* it is appended (ADR 0077) |
| `timers.leases` | claim an execution before waking it, so two nodes don't both pay |
| `timers.dispatcher` | wake on the lane the execution started on, not the poller's |

> **A gate name is not its payload.** `z.object` strips unknown keys — what the schema drops
> is what the log never sees.

## Branching — git-style, no merge

| | |
|---|---|
| `runtime.fork(id, atSequence)` | copy the prefix and continue independently |
| `registry.promote(from, to)` | move a ref; compare-and-set with `expect` |
| `listRefs` / `children` | enumerate branches and lineage |

- A fork inherits the **recorded** wake time, never a re-based one.
- A live branch blocks its parent's retention until it is terminal.
- There is no merge — promote a branch or retire it.

## The three authority rings

All optional, all separate.

| option | gates |
|---|---|
| `security.authorizer` | **effects** — K2 capability ring, allow/deny each effect a step invokes |
| `security.executionAuthorizer` | **lifecycle** — `start` / `resume` / `cancel` / `query`; synchronous, read before anything is appended |
| `security.resumeAuthenticator` | **re-entry** — may this event reopen a suspended execution? A resume arrives from *outside*, so this is the ring an attacker reaches first |

> **`not-applicable` is not a denial.** A resume verdict of `not-applicable` means *not mine
> to judge* and lets the resume proceed. Only `rejected` refuses.

## Data handling

| | |
|---|---|
| `sensitive()` · `internal()` | scrubbed from telemetry egress |
| `secret()` | redacted from step output in the log |
| `@loom/plugin-content` | claim-check: large or PII fields out of the log |
| `@loom/plugin-crypto` | per-subject keys; `destroy` is crypto-shredding. Keys must declare `durable` — losing one erases the subject |
| `@loom/compliance` | subject index, export, erase (T3) |
| `@loom/plugin-audit-chain` | hash-chained log, optional Ed25519 signatures |

## Agentic layer

| | |
|---|---|
| `@loom/agent` | ReAct loop over declared tools |
| `@loom/llm` | provider-agnostic completion + streaming |
| `@loom/memory` | scoped, TTL/size-bounded agent memory |
| `@loom/knowledge` | document corpora over memory, with provenance |
| `@loom/reasoning` | model routing, confidence elevation, critique |
| `@loom/learning` | trajectories, off-policy eval (SNIPS, doubly-robust, bootstrap CIs), promotion gate, policy registry (shadow/canary/rollback), JSONL export |
| `@loom/intent` · `planner` · `capability` | NL → capability → ordered plan |

> **Off-policy eval needs exploration, not history.** Usable evidence ≈ explore-rate ×
> window; a long log with no exploration evaluates nothing.

## Scale and placement

| | |
|---|---|
| `@loom/dispatcher` | where an execution runs; placement policy, circuit breaker |
| `@loom/worker-runtime` | the worker contract — local, remote HTTP, Cloud Run |
| `@loom/graph-executor` | fan a node set into per-node executions |
| `@loom/fair-scheduler` | per-tenant fairness; bounded concurrency |
| `@loom/orchestration` | spawn children, `awaitChild(ren)`, `awaitAll` |
| `@loom/saga` | `createSaga` / `withSaga` — compensate in reverse |

## Reading what happened — no writes

| | |
|---|---|
| `@loom/projection-runtime` | per-execution folds, live subscriptions, slice selectors |
| `@loom/live-query` | `liveQuery` over in-flight state |
| `@loom/plugin-read-model` | durable cross-execution queries, keyset paging |
| `@loom/analytics` | `analyze`, cost, failure, reasoning, model ranking |
| `@loom/replay-inspector` | state at any sequence, off-log |

## Invariants worth memorising

- **P9** — anything that decides an outcome enters the log *once*, and is served from it on
  replay. Never recomputed.
- **P10** — every edge is a pluggable SPI, so a third party never forks the kernel.
- **Recovery is at-least-once.** An interrupted step may run twice; fencing makes that safe,
  not free.
- **"Not configured" and "configured but empty" are different answers.** Loom reports them
  differently, and so should you.
