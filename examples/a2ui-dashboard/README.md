# a2ui-dashboard — one A2UI surface per agent (`a2ui: true`)

A live ops dashboard where **each agent drives its own UI panel**. It's the focused
showcase of `defineConfig({ a2ui: true })`: the flag registers exactly **one A2UI
surface per `agent$`** (`surfaceId = agent.id`), and each agent renders into it with
zero hand-wired surface registration.

```
📊 Ops dashboard for web-2 — one A2UI surface per agent (a2ui: true)

┌─ CPU  ·  web-2  ·  surface:cpu-agent
│  █████████░ 88%  ⚠   [ALERT]
│    · probing cpu on web-2…
│    · CPU = 88% → ALERT
└─
┌─ Memory  ·  web-2  ·  surface:memory-agent …
┌─ Disk  ·  web-2  ·  surface:disk-agent …
```

## The whole idea

```ts
// app.ts — one config call, both batteries-included flags
defineConfig({
  storage: { kind: "memory" },
  flows: PANELS.map((p) => p.flow),
  agents: FLEET,   // the agent$ DEFINITIONS (not hand-built cards)
  a2a: true,       // → derive + register each agent's A2A AgentCard
  a2ui: true,      // → register ONE A2UI surface per agent (surfaceId = agent.id)
});
```

```ts
// flows.ts — each agent renders into ITS OWN surface
const ui = createA2UIEmitter((t, p) => ctx.emit(t, p), agentId); // agentId === surfaceId
ui.set("title", "CPU");
ui.append("log", `probing cpu on ${host}…`);
ui.merge("", { value, status });            // one A2UI_PATCH event each
```

```ts
// read any agent's surface — folded from the log by a2uiSurfaceProjection
app.projectionRuntime.getState("cpu-agent", executionId); // { title, host, value, status, log }
```

## What it shows

- **`a2ui: true` = a surface per agent.** No `surfaces: [...]` list, no
  `projectionRuntime.register(a2uiSurfaceProjection(...))` — passing the `agent$`
  definitions is enough. `getState("cpu-agent", …)` throws for an unregistered
  surface, so the tests double as proof the flag wired it.
- **`a2a: true` alongside it** — the same definitions also become discoverable A2A
  `AgentCard`s, from one flag.
- **Durable + replayable UI.** A2UI updates travel as ordinary `A2UI_PATCH` events, so
  every panel is reconstructable from the event log — the surface is just a projection
  (`a2uiSurfaceProjection`) folded by the runtime.
- **Surfaces are isolated.** Each agent's patches target only its own surface id; one
  agent's panel never leaks into another's (a test asserts this).
- **Renderer-agnostic.** `render.ts` is a ~20-line headless terminal renderer; a real
  client (React `BlueprintRenderer`, Web Components, …) binds the same surface state by
  `{ projectionId: surfaceId, path }` with no changes here.

## Run it

```sh
pnpm start          # dashboard for web-2 (under pressure)
pnpm start web-1    # a healthy host
pnpm test           # asserts each agent's surface reflects its own work
```

Everything is deterministic and offline (metrics keyed off the host — no
`Date.now`/`Math.random`), so runs and tests are stable.
