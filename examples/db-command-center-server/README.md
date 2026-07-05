# DB Command Center — Server + Client

The **same** agentic DB command center as `examples/db-command-center-wc`, but split into a genuine
**server + client** app: the durable, agentic runtime runs on a **Node server** (SQLite event/snapshot
stores); a thin **Web Components client** renders and drives it over **HTTP + SSE**.

This is the production topology from [`docs/architecture.org` → "Deployment & Execution
Model"](../../docs/architecture.org): Loom's **isomorphic core** executing server-side for durability,
its **multi-surface rendering** on the client, bridged by the **resumability seam**
(`serializeProjections` → `seedState`) plus a live patch stream.

```
pnpm --filter @loom/db-command-center-server dev     # client :5173  +  server :8787
# then open http://localhost:5173
```

`dev` runs both processes (a zero-dep spawner). Or run them separately:
`pnpm ... dev:server` (Node runtime, port 8787) and `pnpm ... dev:client` (Vite, proxies `/api`).
`pnpm ... start` builds the client and serves everything from the Node server on one port.

Fully offline (deterministic `DemoLlmProvider`).

## What runs where

| | Server (Node) | Client (browser) |
|---|---|---|
| Durable stores | `SqliteEventStore` + `SqliteSnapshotStore` (`./.data/`) — or **BYO** (see below) | — |
| Runtime | `WorkflowRuntime`, `Orchestrator`, in-process A2A bus, 3 domain agents, durable flows (`ctx.suspend`/`resume`) | — |
| Projections | authoritative `mission` / `telemetry` surfaces | a mirror `InMemoryProjectionRuntime` fed by the stream |
| UI | — | the reused `blueprint$` + `customWidget$` + `dom/` Custom Elements |
| Bundle | — | **~34 kB** (the heavy backend stays on the server) |

### Bring your own backend

This example wires `SqliteEventStore`/`SqliteSnapshotStore` in `src/server/app.ts`, but the store interfaces are **async-first**, so any backend drops in — just swap those two lines:

```ts
const runtime = new WorkflowRuntime({
  eventStore:    new PgEventStore(pool),      // Postgres, Redis, DynamoDB, …
  snapshotStore: new PgSnapshotStore(pool),
  effectRuntime,
  onEvent: (e) => projectionRuntime.handleEvent(e),
});
```

The runtime `await`s the store; the synchronous `ctx.emit`/`ctx.ui` API is unchanged. A runnable Postgres reference (schema + `LISTEN/NOTIFY`) lives in [`docs/examples/postgres-backend/`](../../docs/examples/postgres-backend/README.md).

## Wire protocol (`src/wire.ts`)

- `POST /api/missions {goal}` → start (or restart) the mission; returns `{ missionId }`.
- `GET /api/missions/:id/stream` → **SSE**. On connect the server sends one `snapshot` frame
  (`serializeProjections` of both surfaces); then one `patch` frame per `A2UI_PATCH` as the mission runs.
- `POST /api/missions/:id/approve {approved}` → the human-in-the-loop decision; resumes the
  durably-suspended flow.

**Server** (`src/server/`): `app.ts` builds the durable backend; `BroadcastingProjectionRuntime.ts`
decorates the projection runtime to forward the mission's `A2UI_PATCH` envelopes to SSE clients;
`main.ts` is the `node:http` server + static file serving for prod.
**Client** (`src/client/`): folds each streamed patch into its own projection runtime; the reused
`dom/BlueprintDom` keeps each widget subscribed to only its slice → the same granular, near-real-time
updates. A tab-independent approval banner POSTs the decision back.

## How it differs from `db-command-center-wc`

Everything upstream of the pixels is **reused verbatim** (`domain`, `runtime/*`, `agents/*`,
`capabilities/*`, `a2a/*`, `orchestrator/*`, `blueprints/*`, `widgets/customWidgets.ts`, `dom/*`). The
only changes are the **stores** (SQLite instead of in-memory) and the **boundary**: instead of the
client importing and running the runtime, it talks to a server that does. Same agents, same durable
suspend/resume, same behavior.

## Speculative branching (git-style fork, branch-only)

Because every task is an event-sourced execution with deterministic replay, an execution can be
**forked** at any point into an independent branch — the git *branch-and-pick-a-winner* principle applied
to agents. When a mutating remediation reaches its approval gate and suspends, an operator can fork it into
speculative branches ("what if we approve? what if we reject?"), run each to completion to preview the
outcome, and keep the winner by moving a ref onto it — all while the original task stays suspended and
intact.

- **Fork** is copy-on-write: the parent's events `[0..S]` are copied verbatim into the child execution and
  a seed snapshot is written at the fork point, so the child re-derives the identical pre-fork state (cached
  step outputs are never re-run) and the parent log is never touched. See `WorkflowRuntime.fork()`.
- **Refs + lineage** live in a `SqliteBranchRegistry` (`branches.db`), wired into the runtime in
  `src/server/app.ts`. `promote("spec/x", "main")` repoints the canonical ref onto the winner — a pointer
  move, **no merge**: two divergent `ExecutionState`s have no principled join, so we pick a branch rather
  than reconcile.

Run the narrated end-to-end demo (real `ScaleReplicasFlow`, SQLite stores):

```
pnpm --filter @loom/db-command-center-server demo:fork
```

It starts the scale-read-replicas task, runs it to the approval gate, forks `spec/approve` + `spec/reject`
from the gate, runs both to completion (approve applies the fix → lag falls to ~180ms; reject does not),
shows the parent still suspended, then promotes the winner onto `main`. Source: `src/scripts/speculativeFork.ts`.

## Verify

- `pnpm --filter @loom/db-command-center-server test` — a headless test drives a mission through the
  server's durable wiring (SQLite), asserts the replica goal reaches `awaiting-approval`, resolves after
  approval, streams patches, and writes `events.db`.
- `pnpm --filter @loom/db-command-center-server demo:fork` — runs the speculative-fork demo above end to end.
- Live: `curl -N http://localhost:8787/api/missions/mission-1/stream` in one shell;
  `curl -X POST .../api/missions -d '{"goal":"…"}'` in another; watch the frames.

## Out of scope (not built)

- **Server-restart resume of an in-flight mission.** The event log + snapshots persist to SQLite and the
  flow-level `ctx.suspend`/`resume` is durable, but the `Orchestrator`'s in-memory mission model is not
  rehydrated on a full process restart.
- **Cross-process A2A.** The domain agents run in-process on the server via `InProcessA2ABus`; exposing
  each as its own A2A HTTP service (`createA2AServer`) would be the next step.
- **Interactive fork UI + HTTP routes.** Speculative branching is exercised via the `demo:fork` script and
  the `fork()`/registry APIs; a "Try alternate plan" widget, `POST /api/missions/:id/fork` + `/promote`
  routes, and surfacing branch heads over SSE are the natural next step but are not wired here. (Task-level
  execution events are folded locally, not broadcast — only mission-level `A2UI_PATCH`es stream today.)
