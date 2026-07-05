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
| Durable stores | `SqliteEventStore` + `SqliteSnapshotStore` (`./.data/`) | — |
| Runtime | `WorkflowRuntime`, `Orchestrator`, in-process A2A bus, 3 domain agents, durable flows (`ctx.suspend`/`resume`) | — |
| Projections | authoritative `mission` / `telemetry` surfaces | a mirror `InMemoryProjectionRuntime` fed by the stream |
| UI | — | the reused `blueprint$` + `customWidget$` + `dom/` Custom Elements |
| Bundle | — | **~34 kB** (the heavy backend stays on the server) |

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

## Verify

- `pnpm --filter @loom/db-command-center-server test` — a headless test drives a mission through the
  server's durable wiring (SQLite), asserts the replica goal reaches `awaiting-approval`, resolves after
  approval, streams patches, and writes `events.db`.
- Live: `curl -N http://localhost:8787/api/missions/mission-1/stream` in one shell;
  `curl -X POST .../api/missions -d '{"goal":"…"}'` in another; watch the frames.

## Out of scope (not built)

- **Server-restart resume of an in-flight mission.** The event log + snapshots persist to SQLite and the
  flow-level `ctx.suspend`/`resume` is durable, but the `Orchestrator`'s in-memory mission model is not
  rehydrated on a full process restart.
- **Cross-process A2A.** The domain agents run in-process on the server via `InProcessA2ABus`; exposing
  each as its own A2A HTTP service (`createA2AServer`) would be the next step.
