---
marp: true
theme: default
paginate: true
title: "Loom — DB Command Center as Server + Client"
---

<!-- _paginate: false -->

# DB Command Center — Server + Client

### The *same* agentic command center, split into a durable server + a thin client

**Durable runtime on a Node server (SQLite) · Web Components client over HTTP + SSE**
Loom's isomorphic deployment model, made concrete.

`examples/db-command-center-server`

<!--
Presenter: "We've now shown this app all-in-browser (React) and all-in-browser
(Web Components). This is the production shape: the durable, agentic runtime runs
on a server; the browser is a thin renderer. The point: only the *edges* change."
-->

---

## The premise

The all-browser examples run the *entire* runtime client-side (in-memory stores)
for an offline demo. Production wants the durable core on a **server**.

Loom's core is **isomorphic** — so moving it should change only two things:

1. the **stores** (in-memory → SQLite), and
2. the **client↔server boundary** (in-process calls → HTTP + SSE).

Everything upstream of the pixels is reused **byte-for-byte**.

---

## What runs where

| | Server (Node) | Client (browser) |
|---|---|---|
| Stores | `SqliteEventStore` + `SqliteSnapshotStore` (`./.data/`) | — |
| Runtime | `WorkflowRuntime`, `Orchestrator`, A2A bus, 3 agents, durable `ctx.suspend`/`resume` | — |
| Projections | authoritative `mission` / `telemetry` | a **mirror** `InMemoryProjectionRuntime` |
| UI | — | reused `blueprint$` + `customWidget$` + `dom/` Custom Elements |
| Bundle | — | **~34 kB** (heavy backend stays server-side) |

The client no longer imports the orchestrator, agents, or flows — only the render layer.

---

## Architecture

```
 Browser (Web Components)                 Node server (durable runtime)
 ─────────────────────────               ─────────────────────────────────────────────
  InMemoryProjectionRuntime               POST /api/missions {goal} → orchestrator.run(goal)
   (mirror: mission, telemetry)           GET  /api/missions/:id/stream  (SSE)
  dom/BlueprintDom + elements  ◀──SSE───    • on connect: {kind:"snapshot", serializeProjections}
  approval banner                           • then {kind:"patch", envelope} per A2UI_PATCH
        │ fetch POST                       POST /api/missions/:id/approve {approved}
        └──────────▶ /api ◀────────────    SqliteEventStore + SqliteSnapshotStore (durable)
                                           WorkflowRuntime + Orchestrator + InProcessA2ABus + agents
```

---

## The wire (`src/wire.ts`)

```ts
POST /api/missions          {goal}            → { missionId }        // start / restart
GET  /api/missions/:id/stream                 → SSE
     • {kind:"snapshot", snapshot}  // serializeProjections(mission+telemetry) on connect
     • {kind:"patch", envelope}     // one A2UI_PATCH EventEnvelope per update
POST /api/missions/:id/approve {approved}      → { ok }              // human-in-the-loop
```

One shared file of pure types + route consts, imported by **both** sides
(`import type { EventEnvelope }` — erased from the client bundle).

---

## Server → client, without re-running work

**`BroadcastingProjectionRuntime`** (server) — a `ProjectionRuntime` decorator:

```ts
handleEvent(env) {
  this.inner.handleEvent(env);                       // fold locally
  if (env.eventType === A2UI_PATCH && env.executionId === missionId)
    this.onPatch(env);                               // → fan out to SSE clients
}
snapshot() { return serializeProjections({mission, telemetry}, missionId); }
```

**Client** — seed once, then fold each patch:

```ts
if (frame.kind === "snapshot") for (…state) projection.seedState(surface, id, state);
else                          projection.handleEvent(frame.envelope);   // granular update
```

The flows' `STEP_*` events (other execution ids) fold locally and are **not** streamed.

---

## Human-in-the-loop across the wire

The mutating flow still hits a durable `ctx.suspend` checkpoint on the server:

- The orchestrator surfaces `pendingApproval` on the `mission` surface → streamed to the client.
- The client's tab-independent **approval banner** appears → **Approve** does `POST /approve`.
- The server calls `orchestrator.resolveApproval(...)`, which resumes the durably-suspended flow;
  the completion patches stream back.

> The approval crosses HTTP, but the checkpoint it releases is a durable, event-sourced suspend.

---

## Reused vs. new

**Reused verbatim** from `db-command-center-wc`: `domain`, `runtime/*`, `agents/*`,
`capabilities/*` (durable flows), `a2a/*`, `orchestrator/*`, `blueprints/*`,
`widgets/customWidgets.ts`, and the entire `dom/` render layer.

**New (~5 small files):**
- `server/app.ts` — builds the durable backend (SQLite + runtime + orchestrator).
- `server/BroadcastingProjectionRuntime.ts` — the fan-out decorator.
- `server/main.ts` — `node:http` API + SSE + static serving.
- `client/main.ts` + `client/api.ts` — the mirror projection runtime + `fetch`/`EventSource`.
- `wire.ts`, `scripts/dev.mjs` (zero-dep two-process runner).

---

## Run it

```bash
pnpm --filter @loom/db-command-center-server dev    # client :5173 + durable server :8787
```

Same two goals, same behavior. Or drive the API directly:

```bash
curl -N http://localhost:8787/api/missions/mission-1/stream          # watch frames
curl -X POST http://localhost:8787/api/missions -d '{"goal":"…lag…"}'
curl -X POST http://localhost:8787/api/missions/mission-1/approve -d '{"approved":true}'
```

**Verified:** tsc + Biome clean; client bundle ~34 kB; a headless test drives a mission on SQLite
through approval to resolution (`events.db` written); a live run streamed a snapshot + 64 patches →
`awaiting-approval` → approve → `resolved`.

---

## Bonus: speculative branching on the durable server

Every remediation task is a real event-sourced execution — so it can be **forked**. When a task
suspends at its approval gate, fork it into speculative branches, preview each, keep the winner:

```bash
pnpm --filter @loom/db-command-center-server demo:fork
```

```
scale-read-replicas task → SUSPENDED @ seq 1 (awaiting approval)
  fork → spec/approve → resume(approved) → applied ✓  lag 4200 → 180ms
  fork → spec/reject  → resume(rejected) → no change
  parent task: still SUSPENDED, log untouched
  promote("spec/approve","main") → main now names the winning branch @6
```

- Wired via `branchRegistry: new SqliteBranchRegistry("branches.db")` in `server/app.ts`.
- Copy-on-write over the event log; **no merge** — `promote()` is a pointer move. Source: `src/scripts/speculativeFork.ts`.

<!--
Presenter: an interactive "Try alternate plan" button + POST /fork /promote routes are the natural next step but not wired yet — task-level events fold locally, only mission-level A2UI patches stream today (see the example README "not built"). The demo:fork script proves the mechanics end to end.
-->

---

## Takeaway

> Same app. Same agents. Same durable suspend/resume. We moved the runtime to a
> server and the client got **~6× smaller** — by changing only the **stores** and
> the **boundary**.

- The isomorphic core doesn't care whether it runs in a browser or a server.
- `blueprint$` + projections render from **streamed server state** exactly as they do locally.
- This is the deployment model in `docs/architecture.org` → "Deployment & Execution Model," realized.

> Trio: `db-command-center-deck` (React) · `db-command-center-wc-deck` (Web Components) · **this**.
