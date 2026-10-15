# Getting Started with Loom

This guide takes you from zero to a **durable flow that runs, pauses for a human, and resumes** — in a few minutes. No cloud, no API keys, no database required (it defaults to in-memory storage).

> New to the ideas? Skim the **[mission & core principles](architecture.md#2-core-principles)** first — one page, and everything below will make sense. TL;DR: a Loom flow is an ordinary `async` function whose every meaningful step is recorded to a durable event log, so it can pause, resume, replay, and fork.

---

## Prerequisites

- **Node ≥ 20** and **pnpm ≥ 9** (`corepack enable` gives you pnpm).
- TypeScript. Loom is TypeScript-first and uses [Zod](https://zod.dev) for schemas.

---

## 1. Scaffold an app

Loom's `@loom/*` packages are **not published to npm yet**, so today you build the framework from a
checkout and scaffold your app inside its pnpm workspace (`apps/*` is a workspace glob):

```bash
git clone git@github.com:chhetrisushil/loom.git
cd loom
pnpm install && pnpm build          # `pnpm build:fast` is quicker for the edit-rebuild loop
node tools/create-loom-app/dist/index.js apps/my-app
pnpm install                        # links the new app to the workspace packages
cd apps/my-app && pnpm test         # the scaffold ships a passing test
```

(`pnpm link:global` at the repo root also puts `create-loom-app` and `loom` on your PATH.) The app
declares its `@loom/*` dependencies as `workspace:*`, which is why it has to live inside the checkout.

> **Once published**, this collapses to `npm create loom-app@latest my-app && cd my-app && pnpm install`.
> That command does not work yet.

This wires a minimal app through `defineConfig` — a runtime, in-memory stores, and a projection
surface — so you can run immediately.

**The sibling repos.** The framework repo is deliberately focused; related code lives beside it:

```
workspace/
├── loom/            # the framework (this repo):  pnpm install && pnpm build
├── loom-plugins/    # third-party plugins. Only the `learning-router` example needs it.
└── loom-examples/   # runnable example apps:      git clone, then pnpm install
```

`loom-examples` consumes this repo's unpublished packages from `../loom` through pnpm `overrides`
with `link:` paths (not `workspace:*`, git or npm dependencies), so check it out **next to** `loom`
and build `loom` first. Run an example with `pnpm --filter @loom/<name> start` from that repo; the
[examples catalogue](examples.md) says which one teaches what.

---

## 2. Your first flow

The scaffold already ships a `greet` flow (`app/flows/greet/flow.ts`, registered in `app/config.ts`).
Sections 2 to 7 build **new** flows (`helloFlow`, then `approveFlow`) in files you add under `src/`:
create each file, then add the flow to the `flows` array of your `defineConfig` (in `app/config.ts`),
or use the `defineConfig` snippets below in a scratch script. Section 6 also needs
`@loom/testing` added to the app's `devDependencies` (the scaffold does not include it).

A flow has two parts:

1. **Steps** — units of work (`step$`), optionally with a co-located `handler$`.
2. **A runner** — an ordinary async function that orchestrates the steps via `ctx`.

Create `src/hello.ts`:

```ts
import { z } from "zod";
import { step$, handler$, flow$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { surface } from "@loom/agent-surface";

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

// A runner: plain async orchestration. `surface(ctx)` (from `@loom/agent-surface`) pushes UI updates to a surface.
const runner: FlowRunner<{ name: string }, { message: string }> = async (ctx, input) => {
  surface(ctx).set("phase", "greeting");
  const result = await ctx.run(greetStep, { name: input.name });
  surface(ctx).append("timeline", result.message);
  surface(ctx).set("phase", "done");
  return result;
};

// A RegisteredFlow bundles the declarative definition with its runner.
export const helloFlow: RegisteredFlow = {
  definition: flow$({
    id: "hello",
    name: "Hello",
    version: "1.0.0",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ message: z.string() }),
    steps: [greetStep],
  }),
  // `flows` holds runners of every input/output type, so widen this one (the scaffold does the same).
  runner: runner as FlowRunner<unknown, unknown>,
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
  surfaces: ["default"],            // agent surfaces to project
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
import { surface } from "@loom/agent-surface";

const ApprovalDecision = z.object({ approved: z.boolean(), approvedBy: z.string() });
type ApprovalDecision = z.infer<typeof ApprovalDecision>;

const applyStep = step$({
  id: "apply",
  name: "Apply change",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ applied: z.boolean() }),
  handler: handler$(async (input: { target: string }) => ({ applied: true })),
});

const runner: FlowRunner<{ target: string }, { applied: boolean; approvedBy?: string }> =
  async (ctx, input) => {
    surface(ctx).set("phase", "awaiting-approval");

    // Durable checkpoint: persists, returns control to the caller. The type argument
    // names what the gate delivers; declare the same schema in `resumeSchemas` on the
    // flow so the runtime actually parses it before appending (ADR 0077).
    const decision = await ctx.suspend<ApprovalDecision>({
      on: "ApprovalGranted",
      correlationKey: input.target,
      timeout: 24 * 60 * 60 * 1000, // 24h
    });

    if (!decision.approved) {
      surface(ctx).set("phase", "rejected");
      return { applied: false, approvedBy: decision.approvedBy };
    }

    surface(ctx).set("phase", "applying");
    const { applied } = await ctx.run(applyStep, { target: input.target });
    surface(ctx).set("phase", "done");
    return { applied, approvedBy: decision.approvedBy };
  };

export const approveFlow: RegisteredFlow = {
  definition: flow$({
    id: "approve",
    name: "Approve & Apply",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.object({ applied: z.boolean() }),
    steps: [applyStep],
    // The gate's contract: `resume()` parses the payload against this BEFORE appending it,
    // so a wrongly-shaped approval is refused rather than becoming a permanent fold input.
    resumeSchemas: { ApprovalGranted: ApprovalDecision },
  }),
  runner: runner as FlowRunner<unknown, unknown>,
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

Every command is just a different **lens on the same event log** — the full command reference is the **[CLI Usage Guide](usage-cli.md)**, and the [architecture overview](architecture.md#56-dx-tooling-loomcli-loomappgen-loomeval-loomdeploy-sim-loomtesting-loomscaffold-loomcompiler) explains where it fits.

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

## 7. Going persistent: Postgres, heartbeat, doctor

The in-memory default forgets everything on restart. For a durable, multi-node deployment swap the
storage preset; the flows do not change:

First add `@loom/plugin-postgres` to the app's `package.json` dependencies (`"@loom/plugin-postgres": "workspace:*"`)
and run `pnpm install`; the scaffold's dependencies are `@loom/app`, `core`, `effect-runtime`, `middleware`,
`workflow-runtime`, `agent-surface` (and `@loom/cli` as a dev dependency), which do not include it.

```ts
import { postgresStorage } from "@loom/plugin-postgres";

const app = defineConfig({
  storage: postgresStorage({ url: process.env.DATABASE_URL! }),
  surfaces: ["default"],
  flows: [approveFlow],
  durability: { heartbeat: { ttlMs: 30_000 } },   // optional: these are the defaults
});
```

- The preset creates its schema on first connect and also provides a **lease store in the same
  database**. With it, every driver holds a renewed *heartbeat lease*, so an execution whose driver
  died can be told apart from one that is merely quiet and is re-driven safely. It is on by default
  whenever the store can supply leases; you only set `durability.heartbeat` to tune it.
- Before you deploy, run the pre-flight checks against your built config:

```bash
NODE_OPTIONS="--import tsx" npx loom doctor --config ./loom.config.ts
```

  The scaffold has no build step: `loom.config.ts` at the app root re-exports the app from
  `app/config.ts`, and `tsx` (a scaffold dev dependency) runs it directly. The CLI loads the config
  module with `require`, so `--import tsx` registers the TypeScript loader for it. If you compile
  your config instead, point `--config` at the compiled `.js`. Importing the config starts nothing.

  `doctor` runs every check whose input it can find and tells you which it skipped. It reports the
  heartbeat decision (`heartbeat leases on`, scope `cluster` for Postgres), whether timers can wake,
  whether agent memory is durable, and whether encrypted logs have matching snapshots.

The full runbook (pool sizing, lease tuning, recovery, erasure, backups) is **[Operations](operations.md)**.

---

## Where to go next

| You want to… | Read |
|---|---|
| Build a real, multi-step app end to end | **[Usage](usage.md)** |
| Look up a specific feature (fork, A2A, middleware, projections…) | **[User Guide](user-guide.md)** |
| Understand *why* Loom is built this way | **[Architecture](architecture.md)** |
| See the ideas as a deck | **[Presentation](presentation/loom-deck.md)** |
| Run it in production (Postgres, leases, recovery, backups) | **[Operations](operations.md)** |
| Study runnable apps | [examples catalogue](examples.md) → sibling `loom-examples` repo — start with `loom-starter`, then `incident-war-room` |

**The three moves to remember:**
1. `ctx.run(step, input)` — do a unit of work (recorded, replay-safe).
2. `ctx.suspend<T>({ on })` — pause durably for a human/signal (pair the type argument with a `resumeSchemas` entry, so the claim is also checked).
3. `runtime.fork(id, sequence)` — branch from any point to explore alternatives.
