# 12 — Extension Seams (SPI map)

> **Status:** Reference — the one place that enumerates every *replaceable* seam in Loom.
> Landed by [ADR 0033](../adr/0033-spi-conformance-contracts.md) (accepted item #6 of the
> [Execution-OS evaluation](../requirements/2026-07-10-execution-operating-system-evaluation.md)).

Loom is a **generic execution kernel**: the kernel carries mechanism, and every edge is a
pluggable SPI so third parties can supply their own storage, compute, effects, and policy
without forking Loom (P10). This is the "kernel extension model" — as documentation over the
SPIs that already exist, plus **portable conformance kits** so an implementation can *prove* it
conforms (not just compile against the interface).

## How to start

Every seam below that lists a **conformance kit** can be scaffolded — a package, an SPI stub
with the contract written out, and the conformance test already wired:

```bash
loom plugin seams                       # the seam keys, their titles, and how each is wired
loom plugin new lease my-redis-lease    # → ./loom-plugin-my-redis-lease
```

That is an invariant, not a coincidence: a kit is Loom saying *third parties implement this*,
so a fitness test fails the build if a kitted SPI has no scaffold. Two seams here have no kit
(`Scheduler`, `Warmer`) and are correspondingly not scaffoldable.

## How to prove conformance

Reference impls and third-party impls run the same kit from `@loom/conformance`:

```ts
import { runEventStoreConformance } from "@loom/conformance";
import { MyEventStore } from "./MyEventStore";

runEventStoreConformance(() => new MyEventStore(/* … */), "MyEventStore");
```

The kit exercises the **required** contract and skips **optional** methods a backend omits. Each
reference impl runs the kits against itself — in-memory in
[`packages/conformance/src/index.test.ts`](../../packages/conformance/src/index.test.ts) (which
also pins the per-SPI version constants) and SQLite in
[`plugins/sqlite/src/conformance.test.ts`](../../plugins/sqlite/src/conformance.test.ts) — and
that is what pins the contracts.

## Storage seams

| Seam | Interface | Required | Optional | Reference impls | Conformance kit |
|---|---|---|---|---|---|
| **Event log** | `EventStore` (`@loom/event-runtime`) | `append`, `read`, `readFrom`, `subscribe`, `close` | `readRange`, `acquireFence` (K9.4), `copyPrefix` (fork fast-path), `deleteExecution`/`truncatePrefix` (K10) | `InMemoryAsyncEventStore`, `SqliteEventStore`, `PostgresEventStore` | `runEventStoreConformance` |
| **Snapshots** | `SnapshotStore` (`@loom/snapshot-runtime`) | `save`, `loadLatest`, `loadAt`, `loadLatestBefore`, `close` | `deleteExecution` (K10.1) | `InMemoryAsyncSnapshotStore`, `SqliteSnapshotStore`, `PostgresSnapshotStore` | `runSnapshotStoreConformance` |
| **Branches** | `BranchRegistry` (`@loom/event-runtime`) | `putRef`, `getRef`, `listRefs`, `moveTip`, `promote`, `deleteRef`, `recordLineage`, `getLineage`, `children`, `close` | — | `InMemoryBranchRegistry`, `SqliteBranchRegistry`, `PostgresBranchRegistry` | `runBranchRegistryConformance` |
| **Timers** | `TimerStore` (`@loom/event-runtime`) | `putTimer`, `dueTimers`, `deleteTimer`, `close` | fencing (multi-node) | `InMemoryTimerStore`, `SqliteTimerStore`, `PostgresTimerStore` | `runTimerStoreConformance` |
| **Ownership** | `LeaseStore` (`@loom/event-runtime`) | `acquire` (`null` ⇒ another owner holds it), `renew` (`false` ⇒ ownership lost — never a steal), `expired` (the evidence an execution was orphaned), `release`, `close` | `get` (is anything watching this execution — `orphanCensus`) | `InMemoryLeaseStore`, `SqliteLeaseStore`, `PostgresLeaseStore` | `runLeaseStoreConformance` |
| **Content** | `ContentStore` (`@loom/plugin-content`) | `put` (content-addressed, idempotent by hash), `get` (`null` on absence — MUST NOT throw), `delete` (idempotent physical erasure) | `putStream` (ST-1, ADR 0059), `getMany` (TS-10, ADR 0062) | `InMemoryContentStore`, `CachingContentStore` (decorator), `SqliteContentStore` | `runContentStoreConformance` |
| **Carry state** | `DurableStateStore` (`@loom/plugin-durable-state`) | `load` (`null` when absent), `save` (compare-and-set on `expectedRevision`), `clear` | `close` | `InMemoryDurableStateStore`, `SqliteDurableStateStore`, `PostgresDurableStateStore` | `runDurableStateStoreConformance` |
| **Read models** | `ReadModelStore` (`@loom/plugin-read-model`) | `apply` (idempotent per `rowId`, watermark monotonic), `watermark`, `watermarkedExecutions`, `query` (keyset paging), `clear` | `close` | `InMemoryReadModelStore`, `SqliteReadModelStore`, `PostgresReadModelStore` | `runReadModelStoreConformance` |
| **Subject keys** | `KeyStore` (`@loom/plugin-crypto`) | `getOrCreate`, `get` (`null` when never created OR shredded), `destroy` (irreversible — K10 crypto-shredding) | — | `InMemoryKeyStore` | `runKeyStoreConformance` |
| **Memory** | `MemoryStore` (`@loom/memory`) | `append`, `read`, `clear` — a key names an ORDERED LIST, read back in APPEND order; an entry's caller-assigned `id` MUST round-trip (absent stays absent) | `replace` (atomic whole-list rewrite, so eviction cannot lose a scope), `search` (relevance retrieval over `searchableText`, OR-ed terms, ranking left to the backend; `limit` MUST be routed through `clampSearchLimit` — passed through raw, a negative limit means NO limit on some backends), `remove` (delete by entry id, survivors keeping append order — the verb a MUTABLE corpus needs, since `search` ranks within one key while a document is a subset of it; without it the runtime rewrites the whole key), `close` | `InMemoryMemoryStore` (IDF scorer), `SqliteMemoryStore` (FTS5), `PostgresMemoryStore` (`tsvector`), `loom-plugin-vector` (cosine, 3P) | `runMemoryStoreConformance` |

## Compute seams

| Seam | Interface | Required | Reference impls | Conformance kit |
|---|---|---|---|---|
| **Dispatch** | `ExecutionDispatcher` (`@loom/dispatcher`) | `dispatch`, `cancel`, `health` | `LocalDispatcher`, `PlacementDispatcher` (routing), `SupervisingDispatcher` (K4 circuit-breaker) | `runExecutionDispatcherConformance` |
| **Worker** | `WorkerRuntime` (`@loom/worker-runtime`) | `allocate`, `execute`, `release` (`cancel` optional) | `LocalWorkerRuntime`, `RemoteWorkerRuntime`, `CloudRunWorkerRuntime` | `runWorkerRuntimeConformance` |
| **Timer placement** | `TimerDispatcher` (`@loom/workflow-runtime`) | `dispatch(pkg, meta?)` — run a due wake on the lane the execution was STARTED on (#392), not wherever the poller happens to live. A `target` is a HINT: an unknown one must fall back, never strand the wake | any `ExecutionDispatcher` satisfies it structurally (`LocalDispatcher`, `PlacementDispatcher`) | `runTimerDispatcherConformance` |

## Effect & policy seams

| Seam | Interface | Role | Reference / examples |
|---|---|---|---|
| **Effect** | `Effect<TIn,TOut>` (`@loom/effect-runtime`) | The unit of side effect; `execute` + optional `idempotent`/`warm` | `ToolEffect`, `IsolatedToolEffect` (K7), LLM effect |
| **Middleware** | `EffectMiddleware` (`@loom/effect-runtime`) | Wraps every effect: auth → retry → meter → safety → redact | `retryMiddleware`, `meteringMiddleware` (K3), `safetyMiddleware` (K6), `redactionMiddleware` (K10) |
| **Authority** | `CapabilityAuthorizer` (`@loom/effect-runtime`) | K2 protection ring — allow/deny per effect. Conformance: `runCapabilityAuthorizerConformance` | `GrantTable`, `DelegationAuthorizer` (K12.4) |
| **Lifecycle authority** | `ExecutionAuthorizer` (`@loom/workflow-runtime`) | C.1 — allow/deny an execution OPERATION (`start`/`resume`/`cancel`/`query`), where `CapabilityAuthorizer` gates effects. Synchronous: the verdict is read before anything is appended. Conformance: `runExecutionAuthorizerConformance` | wired as `security.executionAuthorizer` |
| **Resume authority** | `ResumeAuthenticator` (`@loom/workflow-runtime`) | K12.2 — `verify(event)` decides whether an event may REOPEN a suspended execution. The narrowest of the three rings and the one an attacker reaches first: a resume arrives from outside, unlike an effect or a lifecycle call. Three statuses: `not-applicable` means *not mine to judge* and lets the resume proceed — it is not a soft denial. Conformance: `runResumeAuthenticatorConformance` | wired as `security.resumeAuthenticator` |
| **Scheduler** | `Scheduler` (`@loom/scheduler`) | M6 bounded concurrency + priority (advisory; zero-overhead default) | `createScheduler` |
| **Warmer** | `Warmer` (`@loom/effect-runtime`) | M6 advisory pre-warm (latency-only, off-log) | ADR 0027 |
| **Policy** | `Policy<A>` (`@loom/learning`) | Choose an action from an observation — `select(context, actions)`. The **only seam consumed from flow code** rather than `defineConfig`: a learned choice reaches a run through `decideWithPolicy` → `ctx.decide`, so it stays recorded and replayable (ADR 0080). Conformance: `runPolicyConformance` | `loom-plugin-linucb` (3P) |

## Observability & projection seams

| Seam | Interface | Role | Reference / examples |
|---|---|---|---|
| **LLM** | `LlmProvider` (`@loom/llm`) | A model backend — `complete`, optional `stream`/`warm`. A `stream` MUST end with exactly one terminal chunk, and whatever outcome it reports there (`toolCalls`/`stopReason`/`usage`, all optional) MUST equal what `complete` returns for the same request — fold a stream with `assembleStream`. Wired via `createLlmEffect({ provider })` or an agent's `provider`. Conformance: `runLlmProviderConformance` | `AnthropicProvider`, `OpenAiProvider`, `GeminiProvider` |
| **Telemetry** | `TelemetryAdapter` (`@loom/telemetry`) | Spans/metrics over the event stream | OpenTelemetry adapter sketch |
| **Projection** | `ProjectionRuntime` (`@loom/projection-runtime`) | Fold events into read models / UI surfaces. Conformance: `runProjectionRuntimeConformance` | `InMemoryProjectionRuntime` |

## The contract, not the impl, is normative

Alongside the runtime ABIs this completes the "provable contract" story:

- **K1** — kernel syscall ABI (`KERNEL_SYSCALLS` + `abi.test.ts`).
- **K5** — event-schema ABI (`EVENT_SCHEMA_VERSION` + `knownEventTypes()` + `eventSchema.test.ts`).
- **ADR 0033** — the storage SPIs above, via `run<Spi>Conformance` kits.

A third-party runtime is possible precisely because these contracts are pinned and testable —
swap any seam, run its kit, ship.
