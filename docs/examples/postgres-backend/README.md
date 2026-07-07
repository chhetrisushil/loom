# Reference: a Postgres storage backend for Loom

A copy-paste **reference** showing that Loom's async-first storage interfaces accept a real network backend. These files are intentionally *not* part of the workspace build (they'd pull in `pg` + a live database); they exist to demonstrate the contract. Lift them into your own app.

## Use it

```bash
pnpm add pg @types/pg
psql "$DATABASE_URL" -f schema.sql
```

**Recommended — through `defineConfig`** (`storage: { kind: "custom" }`): bring your own backend and still get the one-line composition root everyone else uses.

```ts
import { Pool } from "pg";
import { defineConfig } from "@loom/app";
import { PgEventStore } from "./PgEventStore";
import { PgSnapshotStore } from "./PgSnapshotStore";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = defineConfig({
  storage: {
    kind: "custom",
    eventStore: new PgEventStore(pool),          // ← your network backend
    snapshotStore: new PgSnapshotStore(pool),
    // branchRegistry: new PgBranchRegistry(pool), // optional — for fork()/branching
  },
  surfaces: ["mission"],
  flows: [/* … */],
});
// → app.runtime · app.effectRuntime · app.projectionRuntime · app.bus · app.stores · close()
```

The stores are used verbatim (`app.stores.eventStore` is the `PgEventStore` you passed), and `app.close()` closes them. You get effect middleware, projections, the A2A bus, and boot-time validation for free — the same as a SQLite or in-memory app.

**Or hand-wire `WorkflowRuntime`** directly, if you don't want the composition root:

```ts
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { EffectRuntime } from "@loom/effect-runtime";

const runtime = new WorkflowRuntime({
  eventStore: new PgEventStore(pool),      // ← your network backend
  snapshotStore: new PgSnapshotStore(pool),
  effectRuntime: new EffectRuntime(),
});
```

Either way, that's the whole integration. Everything else — `start` / `resume` / `fork`, suspend/resume, projections — is unchanged, because the runtime already `await`s the store.

## Why this works (and didn't, before)

The storage interfaces are **async-first**: `append`/`read`/`save`/`load*` return Promises and the runtime awaits them. So a backend that does I/O over the network is a first-class citizen — no in-memory shim, no write-behind queue in *your* code.

Two things make it seamless:

- **The runtime never asks the store for a sequence number.** Sequence allocation lives in the per-execution in-memory `ExecutionJournal`, so `append` is a single INSERT — no read-then-write round-trip, and the `UNIQUE(execution_id, sequence)` constraint is the durable safety net.
- **`ctx.emit` / `ctx.stream` / `ctx.ui` stay synchronous** for flow authors. The journal folds the event in memory synchronously and enqueues the durable INSERT on a per-execution FIFO writer; the runtime drains that writer at durability barriers (before completion, and before a snapshot on suspend). Your `append` can take 20ms and the flow code never changes.

## `subscribe` is async for a reason

`EventStore.subscribe` returns `Promise<() => void>`. A network store needs a round-trip to set up delivery — here, a dedicated `LISTEN` connection with Postgres `LISTEN/NOTIFY`. `PgEventStore.append` issues a `pg_notify`; `subscribe` opens a `LISTEN` and returns an unsubscribe that `UNLISTEN`s and releases the connection.

## Not shown

- `BranchRegistry` (speculative branching) — mirror `SqliteBranchRegistry` against the `refs`/`lineage` tables the same way if you use `fork()`.
- Connection-pool tuning, retries/backoff on transient errors (surface as a rejected `append` → the runtime raises `StorageWriteError` at the next barrier), and migrations.
