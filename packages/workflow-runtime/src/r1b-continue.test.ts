import { unwrapTainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { build, echo, eventsOf, flow, kinds, settle, until } from "./__tests__/r2Harness";
import {
  CarryTooLargeError,
  ContinueAsNewRefusedError,
  ContinueAsNewUnavailableError,
} from "./continuation";

// ADR 0109 (R1b) — the happy path: a message loop that rotates every N turns.

const rotating = (every: number) =>
  flow<{ turn?: number; seen?: string[] }, unknown>("loop", async (ctx, input) => {
    let turn = input?.turn ?? 0;
    const seen = [...(input?.seen ?? [])];
    for (;;) {
      const m = unwrapTainted(await ctx.receive<string>("msg")) as string;
      await ctx.run(echo, m);
      seen.push(m);
      turn++;
      if (turn >= every) return ctx.continueAsNew({ turn: 0, seen: seen.slice(-3) });
    }
  });

describe("ctx.continueAsNew — the rotation", () => {
  it("starts the successor first, then commits EXECUTION_CONTINUED; the chain keeps receiving", async () => {
    const h = build({ continueAsNewEnabled: true });
    const f = rotating(2);
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "chat" });
    await settle(handle);
    for (const m of ["a", "b"]) await h.rt.send("chat", { topic: "msg", payload: m, messageId: m });
    await until(async () => (await kinds(h.eventStore, "chat")).includes("EXECUTION_CONTINUED"));

    const first = (await h.eventStore.read("chat~1"))[0];
    expect(first?.eventType).toBe("EXECUTION_STARTED");
    const payload = first?.payload as {
      input: { seen: string[] };
      chainId: string;
      generation: number;
      continuedFrom: {
        executionId: string;
        carried: { inbox: { cursors: Record<string, number> } };
      };
    };
    expect(payload.chainId).toBe("chat");
    expect(payload.generation).toBe(1);
    expect(payload.continuedFrom.executionId).toBe("chat");
    expect(payload.input.seen).toEqual(["a", "b"]);
    expect(payload.continuedFrom.carried.inbox.cursors.msg).toBeGreaterThanOrEqual(0);

    expect((await h.rt.followToHead("chat"))?.executionId).toBe("chat~1");

    const pred = await h.rt.loadState("chat");
    expect(pred?.status).toBe("continued");
    expect(pred?.variables._continuedTo).toBe("chat~1");
    const [cont] = await eventsOf(h.eventStore, "chat", "EXECUTION_CONTINUED");
    expect(cont?.payload).toEqual({ successorId: "chat~1", chainId: "chat", generation: 1 });

    // the chain keeps receiving: a send addressed to the OLD id is delivered to the head once
    await until(async () => (await h.rt.loadState("chat~1"))?.status === "suspended");
    await h.rt.send("chat", { topic: "msg", payload: "c", messageId: "c" });
    await until(
      async () =>
        (
          (await h.rt.loadState("chat~1"))?.variables._inbox as
            | { cursors: Record<string, number> }
            | undefined
        )?.cursors?.msg !== undefined &&
        (await eventsOf(h.eventStore, "chat~1", "MESSAGE_CONSUMED")).length === 1
    );
    expect((await eventsOf(h.eventStore, "chat", "MESSAGE_CONSUMED")).length).toBe(2);
  });

  it("the predecessor's handle resolves with its own `continued` state, never `completed`, and rejects waitForSuspend", async () => {
    const h = build({ continueAsNewEnabled: true });
    const f = flow<{ gen?: number }, unknown>("now", async (ctx, input) =>
      input?.gen === undefined ? ctx.continueAsNew({ gen: 1 }) : "head"
    );
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "n" });
    const done = await handle.waitForCompletion();
    expect(done.status).toBe("continued");
    expect(done.variables._continuedTo).toBe("n~1");
    expect(done.variables._output).toBeUndefined();
    // #710: a terminal run rejects waitForSuspend with ExecutionTerminatedError instead of hanging.
    await expect(handle.waitForSuspend()).rejects.toMatchObject({
      name: "ExecutionTerminatedError",
      status: "continued",
    });
    await until(async () => (await h.rt.loadState("n~1"))?.status === "completed");
    expect((await h.rt.followToHead("n"))?.state.variables._output).toBe("head");
  });

  it("is refused with a typed error when the flag is off, appending nothing", async () => {
    const h = build();
    const f = flow<unknown, unknown>("off", async (ctx) => ctx.continueAsNew({}));
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "x" });
    await expect(handle.waitForCompletion()).rejects.toBeInstanceOf(ContinueAsNewUnavailableError);
    expect(await kinds(h.eventStore, "x")).not.toContain("EXECUTION_CONTINUED");
    expect(await h.eventStore.read("x~1")).toEqual([]);
  });

  it("refuses a carry over maxCarryBytes before anything is appended", async () => {
    const h = build({ continueAsNewEnabled: true, maxCarryBytes: 64 });
    const f = flow<unknown, unknown>("big", async (ctx) => {
      try {
        return await ctx.continueAsNew({ blob: "x".repeat(200) });
      } catch (e) {
        return { caught: (e as Error).name, isCarry: e instanceof CarryTooLargeError };
      }
    });
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "big" });
    const done = await handle.waitForCompletion();
    expect(done.variables._output).toEqual({ caught: "CarryTooLargeError", isCarry: true });
    expect(await h.eventStore.read("big~1")).toEqual([]);
    expect(ContinueAsNewRefusedError).toBeDefined();
  });
});
