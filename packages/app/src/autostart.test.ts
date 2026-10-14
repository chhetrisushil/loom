import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import { InMemoryLeaseStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { TimerRecord } from "@loom/event-runtime";
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
  override async due(
    now: number,
    limit?: number,
    options?: { redrive?: boolean; inbox?: boolean }
  ): Promise<TimerRecord[]> {
    this.polls++;
    return super.due(now, limit, options);
  }
}

async function waitUntil(cond: () => Promise<boolean> | boolean, ceilingMs = 10_000) {
  const deadline = Date.now() + ceilingMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitUntil: ceiling exceeded");
    await new Promise((r) => setTimeout(r, 5));
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

// ── S2 — the composition root must carry what an operator pass needs to find ──
//
// `defineConfig` builds the TimerService itself, so an option it does not forward is an
// option no app can use. Before this, nothing in the repository wired `leases:` into a
// TimerService outside tests — the leased-wake path shipped in #380 had no reachable entry
// point from loom's own front door, while the user guide recommended exactly that signal.

class RecordingLeaseStore extends InMemoryLeaseStore {
  readonly acquired: { executionId: string; owner: string }[] = [];
  override async acquire(executionId: string, owner: string, ttlMs: number, now?: number) {
    this.acquired.push({ executionId, owner });
    return super.acquire(executionId, owner, ttlMs, now);
  }
}

describe("S2 — stores the composition exposes", () => {
  it("exposes the SAME timer and lease instances the app was given", () => {
    const timerStore = new InMemoryTimerStore();
    const leaseStore = new InMemoryLeaseStore();
    const app = defineConfig({
      storage: { kind: "memory" },
      timers: { store: timerStore, leases: { store: leaseStore, owner: "node-a" } },
      autostart: false,
    });
    expect(app.stores.timerStore).toBe(timerStore);
    expect(app.stores.leaseStore).toBe(leaseStore);
  });

  it("omits them when not configured — absent is 'nobody is tracking that', not zero", () => {
    const bare = defineConfig({ storage: { kind: "memory" } });
    expect(bare.stores.timerStore).toBeUndefined();
    expect(bare.stores.leaseStore).toBeUndefined();

    // Timers without leases: one configured, one not. The pair must not move together.
    const timed = defineConfig({
      storage: { kind: "memory" },
      timers: { store: new InMemoryTimerStore() },
      autostart: false,
    });
    expect(timed.stores.timerStore).toBeDefined();
    expect(timed.stores.leaseStore).toBeUndefined();
  });

  it("takes ownership before a wake — the assertion no app could make before", async () => {
    const leases = new RecordingLeaseStore();
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [sleeper()],
      // ADR 0130 D11 (S7c): with heartbeat ON (the default) the wake claims through the runtime's
      // keeper, not `timers.leases`; this test pins the legacy poll-claim path, so heartbeat is off.
      durability: { heartbeat: { enabled: false } },
      timers: {
        store: new InMemoryTimerStore(),
        pollMs: 2,
        leases: { store: leases, owner: "node-a", ttlMs: 30_000 },
      },
    });
    app.effectRuntime.register("wake-tool", new ToolEffect(async () => ({})));

    const handle = await app.runtime.start(sleeper(), {});
    await handle.waitForSuspend();
    await settle(60);

    expect((await app.runtime.loadState(handle.executionId))?.status).toBe("completed");
    // Claimed, by this node, for this execution — the wake ran as an owner, not a racer.
    expect(leases.acquired).toContainEqual({ executionId: handle.executionId, owner: "node-a" });
    await app.close();
  });
});

// ── L27 — an offset `execution.now` still wakes sleeps ────────────────────────
//
// defineConfig hands `now` to the runtime only; the TimerService it builds inherits the
// runtime's clock, so `wakeAt` (computed from that clock) and the comparison agree.

describe("L27 — offset execution.now", () => {
  for (const offset of [-3_600_000, 3_600_000]) {
    it(`wakes a sleeper with the clock offset by ${offset}ms and records wakeAt on it`, async () => {
      const now = () => Date.now() + offset;
      const app = defineConfig({
        storage: { kind: "memory" },
        flows: [sleeper()],
        timers: { store: new InMemoryTimerStore(), pollMs: 2 },
        execution: { now },
      });
      app.effectRuntime.register("wake-tool", new ToolEffect(async () => ({})));

      const before = now();
      const handle = await app.runtime.start(sleeper(), {});
      await handle.waitForSuspend();
      const wakeAt = (await app.runtime.loadState(handle.executionId))?.suspendedOn?.wakeAt;
      // Computed on the configured clock, not the wall.
      expect(wakeAt).toBeGreaterThanOrEqual(before + 5);
      expect(wakeAt).toBeLessThan(before + 5 + 1_000);

      // Poll (generous ceiling) rather than a fixed wall wait, which is load-sensitive.
      // NOTE: this `completed` assertion also passes pre-fix; the recorded-wakeAt
      // assertion above is the regression proof.
      await waitUntil(
        async () => (await app.runtime.loadState(handle.executionId))?.status === "completed"
      );
      expect((await app.runtime.loadState(handle.executionId))?.status).toBe("completed");
      await app.close();
    });
  }

  it("a FIXED execution.now under defineConfig never fires a sleep until the clock advances", async () => {
    const FIXED = 1_000_000;
    let clock = FIXED;
    const store = new CountingTimerStore();
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [sleeper()],
      timers: { store, pollMs: 2 },
      execution: { now: () => clock },
    });
    app.effectRuntime.register("wake-tool", new ToolEffect(async () => ({})));

    const handle = await app.runtime.start(sleeper(), {});
    await handle.waitForSuspend();
    // Let the poller run several times (counted, not timed) with the clock still fixed.
    const seen = store.polls;
    await waitUntil(async () => store.polls >= seen + 5);
    expect((await app.runtime.loadState(handle.executionId))?.status).toBe("suspended");

    clock = FIXED + 1_000; // past wakeAt = FIXED + 5
    await waitUntil(
      async () => (await app.runtime.loadState(handle.executionId))?.status === "completed"
    );
    await app.close();
  });
});
