import type { FlowDefinition } from "@loom/core";
import type { RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestApp } from "./createTestApp";
import { advanceTime, clockOf, fireDueTimers } from "./time";
import { resumeWith } from "./wait";

const DAY = 24 * 60 * 60 * 1000;
const io = z.object({}).passthrough();

function flowOf(
  id: string,
  runner: (ctx: WorkflowContext) => Promise<Record<string, unknown>>
): RegisteredFlow {
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [],
  };
  return { definition, runner } as RegisteredFlow;
}

const sleeper = flowOf("sleeper", async (ctx) => {
  await ctx.sleep(DAY);
  return { woke: true };
});

const nap = flowOf("nap", async (ctx) => {
  const answer = await ctx.suspend<{ ok?: boolean } | undefined>({
    on: "Approval",
    timeout: 60_000,
  });
  return { answered: answer?.ok === true };
});

describe("test clock (time travel)", () => {
  it("a 24h sleep completes once the clock passes it, through the real TimerService", async () => {
    const app = createTestApp({ clock: true, flows: [sleeper] });
    const h = await app.runtime.start(sleeper, {});
    await h.waitForSuspend();

    await advanceTime(app, DAY - 1);
    expect((await app.runtime.loadState(h.executionId))?.status).toBe("suspended");

    await advanceTime(app, 1);
    expect((await app.runtime.loadState(h.executionId))?.status).toBe("completed");
    await app.close();
  });

  it("advancing less than the remaining time fires nothing", async () => {
    const app = createTestApp({ clock: true, flows: [sleeper] });
    const h = await app.runtime.start(sleeper, {});
    await h.waitForSuspend();
    const before = (await app.stores.eventStore.read(h.executionId)).length;

    await advanceTime(app, DAY / 2);
    await fireDueTimers(app);

    expect((await app.stores.eventStore.read(h.executionId)).length).toBe(before);
    expect((await app.runtime.loadState(h.executionId))?.status).toBe("suspended");
    await app.close();
  });

  it("a suspend timeout fires when its time comes", async () => {
    const app = createTestApp({ clock: true, flows: [nap] });
    const h = await app.runtime.start(nap, {});
    await h.waitForSuspend();
    await advanceTime(app, 59_000);
    expect((await app.runtime.loadState(h.executionId))?.status).toBe("suspended");
    await advanceTime(app, 1_000);
    expect((await app.runtime.loadState(h.executionId))?.status).toBe("completed");
    await app.close();
  });

  it("an answered suspend is not disturbed by the timeout passing", async () => {
    const app = createTestApp({ clock: true, flows: [nap] });
    const h = await app.runtime.start(nap, {});
    await h.waitForSuspend();
    await resumeWith(app.runtime, h.executionId, { eventType: "Approval", payload: { ok: true } });
    expect((await app.runtime.loadState(h.executionId))?.status).toBe("completed");
    await advanceTime(app, 120_000);
    expect((await app.runtime.loadState(h.executionId))?.status).toBe("completed");
    await app.close();
  });

  it("the helpers refuse an app without a clock, and clockOf reports it", async () => {
    const plain = createTestApp();
    expect(clockOf(plain)).toBeUndefined();
    await expect(advanceTime(plain, 1)).rejects.toThrow(/no test clock/);
    const timed = createTestApp({ clock: 1000 });
    expect(clockOf(timed)?.now()).toBe(1000);
    await plain.close();
    await timed.close();
  });

  it("drains: more due timers than one poll's batch all fire in one advanceTime", async () => {
    const app = createTestApp({ clock: true, flows: [sleeper] });
    const handles = [];
    for (let i = 0; i < 150; i++) {
      const h = await app.runtime.start(sleeper, {});
      await h.waitForSuspend();
      handles.push(h);
    }
    await advanceTime(app, DAY);
    for (const h of handles) {
      expect((await app.runtime.loadState(h.executionId))?.status).toBe("completed");
    }
    await app.close();
  }, 60_000);

  it("advanceTime refuses a negative, NaN or non-finite delta", async () => {
    const app = createTestApp({ clock: true });
    await expect(advanceTime(app, -1)).rejects.toThrow(/finite number >= 0/);
    await expect(advanceTime(app, Number.NaN)).rejects.toThrow(/finite number >= 0/);
    await expect(advanceTime(app, Number.POSITIVE_INFINITY)).rejects.toThrow(/finite number >= 0/);
    expect(() => clockOf(app)?.advanceBy(-5)).toThrow(/finite number >= 0/);
    await app.close();
  });

  it("an execution.now that disagrees with the clock is refused", () => {
    expect(() => createTestApp({ clock: 1000, execution: { now: () => 5 } })).toThrow(
      /disagrees with the test clock/
    );
  });
});
