# @loom/event-runtime

The durable log's contract (`EventStore`, SPI 2.6.0), an in-memory implementation, and the decorators
that scale or scope any backend. The kernel appends every fact to an `EventStore` and rebuilds state by
folding it, so this is the interface a storage backend implements. You use the package directly to
compose stores for `defineConfig`, to write your own backend, or to write a decorator. The durable
backends live in `@loom/plugin-sqlite` and `@loom/plugin-postgres`.

```ts
import { defineConfig } from "@loom/app";
import {
  CoalescingEventStore,
  InMemoryAsyncEventStore,
  ShardedEventStore,
  TenantScopedEventStore,
  appendBatchOf,
  headOf,
} from "@loom/event-runtime";

// Order from ADR 0074: sharding outermost, then coalescing, then tenant scoping, then the backend.
const shard = () =>
  new CoalescingEventStore(new TenantScopedEventStore(new InMemoryAsyncEventStore(), "acme"), {
    maxBatch: 32,
  });
const events = new ShardedEventStore([shard(), shard()]);

const app = defineConfig({ storage: { kind: "custom", eventStore: events } });

// Optional methods may be absent on a backend: call them through the helpers, which fall back.
export async function tipOf(executionId: string) {
  await appendBatchOf(events, []); // empty input is a no-op
  return headOf(events, executionId); // null when the execution has no events
}
```

## Surface

- **The SPI.** Required: `append`, `read`, `readFrom`, `subscribe`, `close`. Optional, each added in a
  MINOR version: `appendBatch`, `readRange`, `head`, `acquireFence` / `acquireFenceIf`,
  `appendIfUnchanged`, `storeNow`, `copyPrefix`, `deleteExecution`, `deleteThrough`, `truncatePrefix` /
  `truncatePrefixKeeping`, `listExecutions` / `listExecutionsPage`, plus the sealing methods
  `sealingCapability` and `readAtRest`. Callers use `appendBatchOf`, `readRangeOf`, `headOf` and
  `iterateExecutionIds`, which fall back when a method is missing.
- **Stores.** `InMemoryAsyncEventStore` (also importable from `@loom/event-runtime/memory`, which pulls
  in no native modules) and `InMemoryArchiveStore`, `InMemoryLeaseStore`, `InMemoryBranchRegistry`,
  `InMemoryTimerStore`. All are process-local and lose everything on exit.
- **Decorators.** `CoalescingEventStore` (many concurrent appends, one `appendBatch`),
  `ShardedEventStore` + `ShardPlan` (route an execution to one of N stores, rebalance with
  `migrateExecution`), `TenantScopedEventStore` (prefix every id with a tenant), and
  `ProfilingEventStore` (write-side timing, `writeProfile()`).
- **Writing a decorator.** `installOptional` and `DecoratorPlan` make you forward, override or refuse
  every optional method; a plan that omits one does not compile.
- **Errors and reserved ids.** `StaleFenceError`, `DuplicateSequenceError`, `DuplicateEnvelopeIdError`;
  `isReservedStream` and the `__loom_*` stream prefixes.

## Behaviour that surprises people

- **Two uniqueness rules.** A backend must reject a repeated `(executionId, sequence)` with
  `DuplicateSequenceError` and a repeated envelope `id` within an execution with
  `DuplicateEnvelopeIdError`. Neither may be reported as the other, and neither overwrites.
- **`subscribe` can lose a cross-node wake-up.** A local append is delivered synchronously, but a
  wake-up from another node (a dropped listener, a full Postgres NOTIFY queue) is not re-sent. The log
  stays complete. A subscriber that must see a final event re-reads the log on its own timer, as
  `@loom/live-query` does.
- **Batching is atomic per execution, not across executions.** `appendBatch` is equivalent to `append`
  in array order. If a backend omits it, `appendBatchOf` falls back to a sequential loop that is not
  atomic. `CoalescingEventStore` resolves an append only after its batch commits, and one rejected
  envelope (a stale fence, for example) rejects every writer in that batch. It also needs
  `appendBatch` on every layer below it to get the atomicity.
- **Composition order matters.** A decorator that drops an optional method silently takes that
  capability away from everything above it (the original `Coalescing(TenantScoped(...))` batched
  nothing). `runEventStoreDecoratorConformance` in `@loom/conformance` checks yours.
- **Tenant scoping is by key prefix.** `TenantScopedEventStore` throws `TypeError` for an empty tenant
  or one containing `:`. It scopes ids the store sees; it is not encryption.
- **`ShardedEventStore` needs a stable `shardOf`** (the default is a fixed hash), and it advertises an
  optional method only if every shard has it. It throws `ShardSealingMismatchError` when shards
  disagree about sealing. Changing the shard count without a `ShardPlan` re-routes executions.
- **Listing order is part of the SPI.** `listExecutionsPage` pages in Unicode code point order with an
  executionId as the cursor (SPI 2.0.0, ADR 0108).
- **Erasure is signalled by a branded error.** A store that crypto-shreds must throw an error
  recognised by `isPayloadShredded`; any other failure is treated as retryable, not as proof of erasure.

## See also

- API reference: section "`@loom/event-runtime` — the durable log" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [log and read models](../../docs/user-guide/log-and-read-models.md),
  [scaling](../../docs/scaling.md).
- ADRs: [0033 SPI conformance](../../docs/adr/0033-spi-conformance-contracts.md),
  [0074 scale-out decorators](../../docs/adr/0074-storage-scale-out-decorators.md),
  [0075 shard rebalancing](../../docs/adr/0075-shard-rebalancing.md),
  [0108 execution-id order](../../docs/adr/0108-execution-id-order-and-fail-soft-migrations.md).

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).
