import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import { InMemoryTimerStore } from "@loom/event-runtime";
import type { DurableTimer } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";

// ── S1 — composing an app must not be the same act as running it ─────────────
//
// An operator command that reads a deployment's stores does so by IMPORTING its
// config module. If composition starts the timer service, that import begins polling
// production storage and fires whatever is due — a side effect of being inspected,
// caused before any of the command's own code runs. `autostart: false` is the seam;
// `app.start()` is the other half of it.

const io = z.object({});

const wake = step$({
  id: "wake",
  name: "Wake",
  toolId: "wake-tool",
  inputSchema: io,
  outputSchema: io,
});

/** A flow that sleeps — i.e. leaves a real due timer in the store, as production would. */
function sleeper() {
  const definition: FlowDefinition<Record<string, never>, Record<string, never>> = {
    _tag: "FlowDefinition",
    id: "sleeper",
    name: "sleeper",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [wake],
  };
  return {
    definition,
    runner: async (ctx: { sleep: (ms: number) => Promise<void> }) => {
      await ctx.sleep(5);
      return {};
    },
  };
}

/** Records polls, so "never started" is observable rather than merely asserted. */
class CountingTimerStore extends InMemoryTimerStore {
  polls = 0;
  override async due(now: number, limit?: number): Promise<DurableTimer[]> {
    this.polls++;
    return super.due(now, limit);
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("S1 — autostart", () => {
  it("does not poll, and leaves a due timer unfired, until start() is called", async () => {
    const store = new CountingTimerStore();
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [sleeper()],
      timers: { store, pollMs: 2 },
      autostart: false,
    });
    app.effectRuntime.register("wake-tool", new ToolEffect(async () => ({})));

    const handle = await app.runtime.start(sleeper(), {});
    await handle.waitForSuspend();
    const sequenceAtRest = (await app.stores.eventStore.read(handle.executionId)).length;

    // Well past both the sleep (5ms) and the poll interval (2ms).
    await settle(40);

    expect(store.polls).toBe(0); // nothing is watching
    const state = await app.runtime.loadState(handle.executionId);
    expect(state?.status).toBe("suspended"); // ...so the wake did not happen
    expect((await app.stores.eventStore.read(handle.executionId)).length).toBe(sequenceAtRest);

    // The other half of the switch: an app built without starting can still be started.
    app.start();
    await settle(40);

    expect(store.polls).toBeGreaterThan(0);
    const woken = await app.runtime.loadState(handle.executionId);
    expect(woken?.status).toBe("completed");
    await app.close();
  });

  it("starts at composition time by default, and start() is idempotent", async () => {
    const store = new CountingTimerStore();
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [sleeper()],
      timers: { store, pollMs: 2 },
    });
    app.effectRuntime.register("wake-tool", new ToolEffect(async () => ({})));

    const handle = await app.runtime.start(sleeper(), {});
    await handle.waitForSuspend();
    await settle(40);
    expect((await app.runtime.loadState(handle.executionId))?.status).toBe("completed");

    // A second start must not add a second poller — the count keeps climbing at ONE
    // interval's pace, not two. (TimerService.start guards; this pins that it stays true.)
    const before = store.polls;
    app.start();
    app.start();
    await settle(20);
    const perInterval = (store.polls - before) / 10; // ~1 poll per 2ms over 20ms
    expect(perInterval).toBeLessThan(2);
    await app.close();
  });

  it("start() is a no-op when nothing with a lifecycle is configured", () => {
    const app = defineConfig({ storage: { kind: "memory" } });
    expect(() => app.start()).not.toThrow();
  });
});
