# Cheatsheet — what Loom gives you

> Card I of two. The durable-execution kernel: a small syscall table, the builders that declare
> work, and the subsystems layered on the log. Everything here survives a process dying mid-step.
> Agents are one workload; the kernel is just as happy running none (see
> [Not only agents](#not-only-agents--long-running-workflows)).
> Card II is [the developer workflow](cheatsheet-dx.md).
>
> KERNEL ABI **1.3.0** · EVENT SCHEMA **1.25.0** · EventStore SPI **2.5.0** ·
> BranchRegistry SPI **2.0.0** · LeaseStore SPI **2.2.0** · MemoryStore SPI **2.1.0**

## The syscalls

Ten from 1.0/1.1, four added in 1.3.0 (`receive`, `select`, `continueAsNew`, `negotiateBudget`).
Everything else is built from these; feature-detect against the advertised list, not the version.

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
| `conversation$` | a durable chat over one chained execution — `@loom/conversation` |

## Composition — `defineConfig`

Options are **grouped**; flat spellings throw, with no deprecation window.

```ts
defineConfig({
  storage: { kind: "custom", eventStore, snapshotStore },
  timers:  { store, leases, dispatcher, schedules },
  autostart: false,        // build, don't run
  kernel: { features: { scopes, inbox, inboxTopicStreams, continueAsNew, redrive } },  // opt-in syscalls
  security:      { … },    // the three rings, strict, crypto, compliance, killSwitch
  observability: { … },    // onEvent, telemetry, onWarn, onStorageError, reasoning
  durability:    { … },    // snapshotEvery, retention, heartbeat leases (ADR 0130 D11)
  execution:     { … },    // dispatcher, effectMiddleware, registerEffects, envelope, now
  checks:        { … },    // validate, verify (boot-time pre-flight)
})
```

> `security.strict` makes `defineConfig` throw unless an `authorizer` and `executionAuthorizer`
> are supplied and `checks.verify` stays on; it also installs a default deadline, the autonomy
> `envelope` (spawn/spend caps) and `app.killSwitch`. Unset, it logs one advisory.
>
> **Heartbeat leases are on by default** (`durability.heartbeat`, ADR 0130 D11): the lease store
> is co-located with the event store, acquired lazily after `lazyGraceMs` (`acquire: "eager"`
> to lease before the first append). A durable event store with no derivable lease store
> disables it (`loom doctor` says so). See [operations](operations.md#2-heartbeat-leases).
>
> `autostart: false` builds the app without starting its timer service — what an operator
> command needs so that *inspecting* a deployment never fires its schedules. `app.start()`
> is the other half.

## Time and waiting

| | |
|---|---|
| `suspend({ on })` | wait for a named gate; resume by event type |
| `suspend({ timeout })` | needs a `TimerStore`, or it never wakes |
| `resumeSchemas` | parse a resume payload *before* it is appended (ADR 0077) |
| `ctx.sleep(ms)` · `ctx.sleepUntil(t)` | durable timers; need a `TimerStore`; the wake is a logged fact |
| `runtime.send` → `ctx.receive` / `ctx.select` | durable inbox: queue a message into a *running or parked* execution (ADR 0110); `kernel.features.inbox` |
| `runtime.quarantineInbox` / `releaseInbox` / `discardInbox` | operator verbs on a topic: hold, release in order, drop (principal required; ADR 0110, 0130) |
| `timers.leases` | claim an execution before waking it, so two nodes don't both pay |
| `timers.dispatcher` | wake on the lane the execution started on, not the poller's |

> **A gate name is not its payload.** `z.object` strips unknown keys — what the schema drops
> is what the log never sees.

## Not only agents — long-running workflows

The kernel never calls a model. A flow with no `agent$` is a first-class use: approval chains,
onboarding, billing runs, ETL steps, order sagas, anything that must outlive its process.

| need | use |
|---|---|
| a unit of work that is not repeated on replay | `step$` + `ctx.run` (`retry` and `timeoutMs` on the step, `deadlineMs` on the flow) |
| wait hours or days | `ctx.sleep` / `ctx.sleepUntil` — survives restarts; needs a `TimerStore` |
| wait for a human or webhook | `ctx.suspend({ on, timeout? })` + `flow$({ resumeSchemas })` to validate the payload |
| run on a calendar | `schedule$({ id, cron, timeZone?, flowId })` in `timers.schedules`; one idempotent start per occurrence |
| undo on failure | `@loom/saga` — `withSaga(ctx, saga => saga.run(step, input, compensator))`; compensators run in reverse; a failing compensator does not abort the rollback and `withSaga` then throws `SagaCompensationError` (original as `cause`); a cancellation or other runtime signal propagates unchanged |
| parent and child workflows | `@loom/orchestration` — `awaitChild` · `awaitChildren` · `awaitAll` (wire `superviseChildren`) |
| map one step over many items | `fanout$(ctx, step, items)` — bounded concurrency, one step id per item |
| long-lived loop | `continueAsNew` to bound history; the inbox as an event-driven mailbox |

```ts
import { withSaga } from "@loom/saga";
import { awaitChildren } from "@loom/orchestration";
import type { ExecutionContext } from "@loom/workflow-runtime";

// inside a flow runner; reserve/charge are step$ definitions, release/refund their compensators
async function run(ctx: ExecutionContext, order: { id: string }) {
  await withSaga(ctx, async (saga) => {
    await saga.run(reserve, order, release);
    await ctx.sleep(24 * 60 * 60 * 1000); // a day, durably
    await saga.run(charge, order, refund); // if this throws, refund/release run in reverse
  });
  return awaitChildren(ctx, { key: "ship", children: [{ flowId: "ship", input: order }] });
}
```

Start from a template: `loom new flow <name> --template approval|timer|saga` scaffolds each of the
rows above (typed gate, durable timer, compensation; `echo` is the minimal one) with a test that passes on a fresh scaffold.
Test time without waiting: `createTestApp({ clock: true })` and `advanceTime(app, ms)` from
`@loom/testing` move the runtime's clock and fire what became due through the real `TimerService`.

Honest limits:

- **The flow body must be deterministic.** It is re-run from the top on every resume, with
  syscalls served from the log: no bare `Date.now()`, `Math.random()` or `fetch()` outside a
  step or `ctx.decide`. Changing a deployed body mid-flight needs a version, not an edit (ADR 0113).
- **Throughput is log-bound** — thousands of durable executions per second per store, not
  millions; bound a very long history with `snapshotEvery` and `ctx.continueAsNew`.
- **At-least-once**: an interrupted step may run twice, so side effects need idempotency keys.
- **It is not a query database.** The log answers "what happened to execution X"; cross-execution
  questions go to `@loom/plugin-read-model`. Timers fire at poll granularity, not to the millisecond.

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
| `@loom/plugin-crypto` | per-subject keys; `destroy` is crypto-shredding. Keys must declare `durable` — losing one erases the subject. Seals inbox payloads and, with `sealState`, whole checkpoints |
| `@loom/compliance` | subject index, `app.exportSubject` / `app.eraseSubject` (parks while the subject has live executions) |
| `@loom/plugin-audit-chain` | hash-chained log, optional Ed25519 signatures |

## Agentic layer

| | |
|---|---|
| `@loom/agent` | `agentLoop$` — ReAct loop over declared tools. `needsApproval` (`true` **parks**; bound to what the approver saw), `parallelTools`, `writeBack` (memory), `toolSearch` / `skillActivation` for big menus, `returnsMedia` tools |
| `@loom/conversation` | `conversation$` / `createConversations`: multi-turn chat on one chained execution; barge-in; token budget; `shared` mode runs each turn as its asker. SSE: `@loom/plugin-conversation-sse` |
| `@loom/llm` | provider-agnostic completion + streaming; content parts (images, files) claim-checked by address via a `ContentResolver` (ADR 0120) |
| `@loom/memory` | scoped, TTL/size-bounded agent memory |
| `@loom/knowledge` | document corpora over memory, with provenance |
| `@loom/reasoning` | model routing, confidence elevation, critique |
| `@loom/learning` | trajectories, off-policy eval (SNIPS, doubly-robust, bootstrap CIs), promotion gate, policy registry (shadow/canary/rollback), JSONL export |
| `@loom/intent` · `planner` · `capability` | NL → capability → ordered plan. A configured model's answer is **final**: `NONE` is not overridden by a keyword guess; `routeExplained()` returns `{ route, reason }` (`model-none`, `model-unparseable`, …) |

> **Off-policy eval needs exploration, not history.** Usable evidence ≈ explore-rate ×
> window; a long log with no exploration evaluates nothing.

## Surfaces and integrations

| | |
|---|---|
| `@loom/agent-surface` | `surface(ctx)` — durable, replayable UI patches (replaces `ctx.ui`) |
| `@loom/blueprint-runtime` + `plugin-renderer-{dom,react,terminal}` | one Blueprint IR, several renderers |
| `plugin-a2a` · `plugin-mcp` · `plugin-a2ui` · `plugin-mcp-app` | agent-to-agent, MCP client, A2UI and MCP-App egress |
| `plugin-sandbox` · `@loom/isolate` | run LLM-authored code / tool effects in a separate authority domain |
| `plugin-sentinel` · `plugin-durable-state` | perpetual-agent preset; typed state carried across bounded runs |

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
- **A recorded decision has a position.** Each folded `DECISION_RECORDED` carries its sequence
  through checkpoints (ADR 0128), so replay order survives compaction.
- **An owner-resolution fault is retryable.** Under an execution authorizer it surfaces as `ExecutionStoreUnavailableError`, never a false denial of the owner or an admission of a stranger (ADR 0039). A shredded payload is recognised by `isPayloadShredded` (realm-safe brand; `brandPayloadShredded` for a custom store), not by error name.
- **A node that cannot open a sealed payload refuses it** — never delivers the envelope as if it
  were the user's data (ADR 0130); the wake is left for a capable node.
- **Recovery is at-least-once.** An interrupted step may run twice; fencing makes that safe,
  not free.
- **"Not configured" and "configured but empty" are different answers.** Loom reports them
  differently, and so should you.
