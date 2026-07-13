# Getting Started with Loom

This guide takes you from zero to a **durable flow that runs, pauses for a human, and resumes** — in a few minutes. No cloud, no API keys, no database required (it defaults to in-memory storage).

> New to the ideas? Skim the **[mission & core principles](architecture.md#2-core-principles)** first — one page, and everything below will make sense. TL;DR: a Loom flow is an ordinary `async` function whose every meaningful step is recorded to a durable event log, so it can pause, resume, replay, and fork.

---

## Prerequisites

- **Node ≥ 20** and **pnpm ≥ 9** (`corepack enable` gives you pnpm).
- TypeScript. Loom is TypeScript-first and uses [Zod](https://zod.dev) for schemas.

---

## 1. Scaffold an app

```bash
npm create loom-app@latest my-app
cd my-app
pnpm install
```

This wires a minimal app through `defineConfig` — a runtime, in-memory stores, and a projection surface — so you can run immediately.

> Working inside this monorepo instead? Everything below works against the workspace packages; run `pnpm install && pnpm build` at the repo root first.

---

## 2. Your first flow

A flow has two parts:

1. **Steps** — units of work (`step$`), optionally with a co-located `handler$`.
2. **A runner** — an ordinary async function that orchestrates the steps via `ctx`.

Create `src/hello.ts`:

```ts
import { z } from "zod";
import { step$, handler$, flow$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";

// A step: schema-checked input/output + the work to do.
const greetStep = step$({
  id: "greet",
  name: "Greet",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  handler: handler$(async (input: { name: string }) => ({
    message: `Hello, ${input.name}!`,
  })),
});

// A runner: plain async orchestration. `ctx.ui.*` pushes UI updates to a surface.
const runner: FlowRunner<{ name: string }, { message: string }> = async (ctx, input) => {
  ctx.ui.set("phase", "greeting");
  const result = await ctx.run(greetStep, { name: input.name });
  ctx.ui.append("timeline", result.message);
  ctx.ui.set("phase", "done");
  return result;
};

// A RegisteredFlow bundles the declarative definition with its runner.
export const helloFlow: RegisteredFlow<{ name: string }, { message: string }> = {
  definition: flow$({
    id: "hello",
    name: "Hello",
    version: "1.0.0",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ message: z.string() }),
    steps: [greetStep],
  }),
  runner,
};
```

---

## 3. Run it

The fastest path is `defineConfig`, which assembles the runtime and stores for you. Create `src/main.ts`:

```ts
import { defineConfig } from "@loom/app";
import { helloFlow } from "./hello";

const app = defineConfig({
  storage: { kind: "memory" },     // in-memory; use sqliteStorage({ dir: ".loom" }) to persist
  surfaces: ["default"],            // A2UI surfaces to project
  flows: [helloFlow],
});

const handle = await app.runtime.start(helloFlow, { name: "Ada" });
const state = await handle.waitForCompletion();

console.log(state.status);                         // "completed"
console.log(state.variables._output);              // { message: "Hello, Ada!" }
console.log(app.projectionRuntime.getState("default", handle.executionId)); // { phase: "done", timeline: ["Hello, Ada!"] }

await app.close();
```

```bash
pnpm tsx src/main.ts
```

You just ran a durable execution: every step was recorded to the event log, and the read-model surface was folded from those same events.

---

## 4. Pause for a human, then resume

The feature that sets Loom apart: a flow can **suspend** at a durable checkpoint and be **resumed** later — even after a restart. Add an approval gate.

`src/approve.ts`:

```ts
import { z } from "zod";
import { step$, handler$, flow$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";

const applyStep = step$({
  id: "apply",
  name: "Apply change",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ applied: z.boolean() }),
  handler: handler$(async (input: { target: string }) => ({ applied: true })),
});

const runner: FlowRunner<{ target: string }, { applied: boolean; approvedBy?: string }> =
  async (ctx, input) => {
    ctx.ui.set("phase", "awaiting-approval");

    // Durable checkpoint: persists, returns control to the caller.
    const decision = (await ctx.suspend({
      on: "ApprovalGranted",
      correlationKey: input.target,
      timeout: 24 * 60 * 60 * 1000, // 24h
    })) as { approved: boolean; approvedBy: string };

    if (!decision.approved) {
      ctx.ui.set("phase", "rejected");
      return { applied: false, approvedBy: decision.approvedBy };
    }

    ctx.ui.set("phase", "applying");
    const { applied } = await ctx.run(applyStep, { target: input.target });
    ctx.ui.set("phase", "done");
    return { applied, approvedBy: decision.approvedBy };
  };

export const approveFlow: RegisteredFlow<
  { target: string },
  { applied: boolean; approvedBy?: string }
> = {
  definition: flow$({
    id: "approve",
    name: "Approve & Apply",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.object({ applied: z.boolean() }),
    steps: [applyStep],
  }),
  runner,
};
```

Drive it to suspension, then resume:

```ts
import { defineConfig } from "@loom/app";
import { approveFlow } from "./approve";

const app = defineConfig({ storage: { kind: "memory" }, surfaces: ["default"], flows: [approveFlow] });

// 1) Start — it runs until it hits ctx.suspend(), then hands control back.
const handle = await app.runtime.start(approveFlow, { target: "prod-db" });
const suspended = await handle.waitForSuspend();
console.log(suspended.status); // "suspended"

// 2) …time passes. The execution lives in durable storage; the process could even restart.

// 3) Resume with the decision. The payload becomes the return value of ctx.suspend().
const resumed = await app.runtime.resume(handle.executionId, {
  eventType: "ApprovalGranted",
  payload: { approved: true, approvedBy: "ada@example.com" },
});
const done = await resumed.waitForCompletion();

console.log(done.status);              // "completed"
console.log(done.variables._output);   // { applied: true, approvedBy: "ada@example.com" }

await app.close();
```

**What just happened:** on `resume`, the flow function re-ran from the top, but the already-recorded portion was served from the log (no effect re-executed), the `suspend()` call returned the resume payload, and the flow continued deterministically. That is Loom's [deterministic replay](architecture.md#42-the-durable-write-pipeline) at work.

---

## 5. Inspect what happened

Persist to SQLite so the CLI can read the log:

```ts
const app = defineConfig({ storage: sqliteStorage({ dir: ".loom" }), surfaces: ["default"], flows: [approveFlow] });
```

Then, from your project root:

```bash
# Tail the event timeline for an execution
npx loom logs --db .loom/events.db <executionId>

# Time-travel: fold the state as it was at sequence N
npx loom debug --db .loom/events.db <executionId> --at 3

# Open the web inspector (timeline + time-travel slider)
npx loom inspect --db .loom/events.db <executionId>
```

Every command is just a different **lens on the same event log** — the full command reference is the **[CLI Usage Guide](usage-cli.md)**, and the [architecture overview](architecture.md#56-dx-tooling-loomcli-loomeval-loomdeploy-sim-loomtesting-loomscaffold-loomcompiler) explains where it fits.

---

## 6. Write a test

Loom's testing kit spins up an in-memory app and waits on surfaces deterministically:

```ts
import { describe, it, expect } from "vitest";
import { createTestApp, waitForPhase } from "@loom/testing";
import { approveFlow } from "../src/approve";

describe("approve flow", () => {
  it("suspends for approval, then applies on resume", async () => {
    const app = createTestApp({ surfaces: ["default"], flows: [approveFlow] });

    const handle = await app.runtime.start(approveFlow, { target: "prod-db" });
    await handle.waitForSuspend();
    await waitForPhase(app.projectionRuntime, "default", handle.executionId, "awaiting-approval");

    const resumed = await app.runtime.resume(handle.executionId, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "test" },
    });
    const done = await resumed.waitForCompletion();

    expect(done.status).toBe("completed");
    expect(done.variables._output).toMatchObject({ applied: true });
    await app.close();
  });
});
```

---

## Where to go next

| You want to… | Read |
|---|---|
| Build a real, multi-step app end to end | **[Usage](usage.md)** |
| Look up a specific feature (fork, A2A, middleware, projections…) | **[User Guide](user-guide.md)** |
| Understand *why* Loom is built this way | **[Architecture](architecture.md)** |
| See the ideas as a deck | **[Presentation](presentation/loom-deck.md)** |
| Study runnable apps | [`examples/`](../examples) — start with `agent-network`, then `incident-war-room` |

**The three moves to remember:**
1. `ctx.run(step, input)` — do a unit of work (recorded, replay-safe).
2. `ctx.suspend({ on, correlationKey })` — pause durably for a human/signal.
3. `runtime.fork(id, sequence)` — branch from any point to explore alternatives.
