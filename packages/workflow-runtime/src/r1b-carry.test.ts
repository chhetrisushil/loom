import { unwrapTainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { build, eventsOf, flow, kinds, settle, until } from "./__tests__/r2Harness";
import type { Harness } from "./__tests__/r2Harness";

// ADR 0109 D3 — what the successor INHERITS (resources, the inbox cursors + dedupe window, the
// chain deadline, the principal) and what it does NOT (the fold), and D5/R11: outcomes on a
// continued generation, children cascade.

const on = { continueAsNewEnabled: true } as const;
const status = async (h: Harness, id: string) =>
  (await h.rt.loadState(id, h.rt.systemOptions()))?.status;
const parkedOrDone = async (h: Harness, id: string) =>
  ["suspended", "completed"].includes((await status(h, id)) ?? "");

describe("ADR 0109 D3 — the carry", () => {
  it("running resource totals ride the successor's start, so a rotation cannot reset a quota", async () => {
    const h = build(on);
    const f = flow<{ gen?: number }, unknown>("meter", async (ctx, input) => {
      if (input?.gen === undefined) {
        ctx.emit("RESOURCE_METERED", { tokens: 120, costUsd: 0.5, custom: { gpu_seconds: 3 } });
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      ctx.emit("RESOURCE_METERED", { tokens: 30 });
      await ctx.receive("never");
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "q" }));
    await h.rt.send("q", { topic: "go", payload: 1 });
    await until(async () => (await status(h, "q~1")) === "suspended");
    const carried = (
      (await h.eventStore.read("q~1"))[0]?.payload as {
        continuedFrom: { carried: { resources: Record<string, unknown> } };
      }
    ).continuedFrom.carried.resources;
    expect(carried.tokens).toBe(120);
    const succ = await h.rt.loadState("q~1");
    const r = succ?.variables._resources as {
      tokens: number;
      costUsd: number;
      custom: Record<string, number>;
    };
    expect(r.tokens).toBe(150); // 120 carried + 30 of its own
    expect(r.costUsd).toBe(0.5);
    expect(r.custom.gpu_seconds).toBe(3);
  });

  it("does NOT carry the fold: no frames, decisions, resume payloads, outcomes", async () => {
    const h = build(on);
    const f = flow<{ gen?: number }, unknown>("fold", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.decide("route", () => "a");
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      await ctx.receive("never");
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "fo" }));
    await h.rt.send("fo", { topic: "go", payload: 1 });
    await until(async () => (await status(h, "fo~1")) === "suspended");
    const pred = await h.rt.loadState("fo");
    expect(Object.keys((pred?.variables._decisions as object) ?? {})).toEqual(["route"]);
    const succ = await h.rt.loadState("fo~1");
    expect(succ?.variables._decisions).toBeUndefined();
    expect(Object.keys(succ?.frames ?? {})).toEqual([]);
    expect(succ?.variables._outcomes).toBeUndefined();
    expect(succ?.variables._resumePayloads).toBeUndefined();
  });

  it("the dedupe window survives rotation: a sender retry after a rotation is skipped, not delivered", async () => {
    const h = build(on);
    const f = flow<{ gen?: number }, unknown>("dd", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.receive("q");
        return ctx.continueAsNew({ gen: 1 });
      }
      const got: unknown[] = [];
      for (;;) got.push(unwrapTainted(await ctx.receive("q")));
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "dd" }));
    await h.rt.send("dd", { topic: "q", payload: 1, messageId: "dup" });
    await until(async () => (await status(h, "dd~1")) === "suspended");
    const carried = (
      (await h.eventStore.read("dd~1"))[0]?.payload as {
        continuedFrom: {
          carried: { inbox: { dedupe: string[]; cursors: Record<string, number> } };
        };
      }
    ).continuedFrom.carried.inbox;
    expect(carried.dedupe).toHaveLength(1);
    expect(carried.cursors.q).toBe(0);
    // the sender retries the SAME message after the rotation, then sends a fresh one
    await h.rt.send("dd", { topic: "q", payload: 1, messageId: "dup" });
    await h.rt.send("dd", { topic: "q", payload: "fresh", messageId: "fresh" });
    await until(async () => (await eventsOf(h.eventStore, "dd~1", "MESSAGE_CONSUMED")).length >= 2);
    const consumed = await eventsOf(h.eventStore, "dd~1", "MESSAGE_CONSUMED");
    // the duplicate advanced the cursor (so it is not read again) but delivered NOTHING: only the
    // fresh `q` message answered a wait
    const answers = (await h.rt.loadState("dd~1"))?.variables._waitAnswers as Record<
      string,
      { payload: unknown }
    >;
    expect(Object.values(answers).map((a) => unwrapTainted(a.payload))).toEqual(["fresh"]);
    expect(consumed.length).toBe(2);
  });

  it("a message sent AFTER the rotation, to the old id, is delivered once to the successor", async () => {
    const h = build(on);
    const f = flow<{ gen?: number }, unknown>("late", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      return unwrapTainted(await ctx.receive("q"));
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "l" }));
    await h.rt.send("l", { topic: "go", payload: 1 });
    await until(async () => (await status(h, "l~1")) === "suspended");
    await h.rt.send("l", { topic: "q", payload: "hello" });
    await until(async () => (await status(h, "l~1")) === "completed");
    expect((await h.rt.loadState("l~1"))?.variables._output).toBe("hello");
    expect(await eventsOf(h.eventStore, "l", "MESSAGE_CONSUMED")).toHaveLength(1); // only `go`
    expect(await eventsOf(h.eventStore, "l~1", "MESSAGE_CONSUMED")).toHaveLength(1);
  });

  it("the chain's ABSOLUTE deadline is fixed at generation 0 and survives rotation", async () => {
    const h = build(on);
    const f = flow<{ gen?: number }, unknown>("dl", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      return unwrapTainted(await ctx.receive("q"));
    });
    // Windows are wide on purpose: the assertion below needs "the chain deadline has passed but a
    // FRESH deadline from the late successor's start has not", and a narrow window (it was 130 ms)
    // closes under CI load before the test can act.
    const DEADLINE = 2_000;
    const LATE = 1_500;
    f.definition.deadlineMs = DEADLINE;
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "dl" }));
    const start0 = (await h.eventStore.read("dl"))[0]?.timestamp as number;
    await new Promise((r) => setTimeout(r, LATE)); // a real delay: the successor starts LATE
    await h.rt.send("dl", { topic: "go", payload: 1 });
    await until(async () => (await status(h, "dl~1")) === "suspended");
    const first = (await h.eventStore.read("dl~1"))[0];
    const carried = (first?.payload as { continuedFrom: { carried: { chainDeadline: number } } })
      .continuedFrom.carried;
    expect(carried.chainDeadline).toBe(start0 + DEADLINE); // fixed at generation 0, not at the rotation
    // A parked execution holds no deadline timer (it re-arms on resume, "resuming past the deadline
    // cancels immediately"), so resume the successor once the CHAIN's deadline has passed but a
    // FRESH one (start1 + DEADLINE, start1 >= start0 + LATE) has not.
    await until(() => Date.now() > start0 + DEADLINE + 20, 6000);
    expect(Date.now()).toBeLessThan((first?.timestamp as number) + DEADLINE); // timing-bound: precondition, a ~1.5 s window (LATE) after the chain deadline
    await h.rt.send("dl~1", { topic: "q", payload: "too late" });
    await until(async () => (await status(h, "dl~1")) === "cancelled", 3000);
    const cancelled = (await eventsOf(h.eventStore, "dl~1", "EXECUTION_CANCELLED"))[0];
    expect((cancelled?.payload as { reason?: string }).reason).toMatch(/deadline/);
    // a cancel is terminal: the flow's own return does not follow it
    expect(await kinds(h.eventStore, "dl~1")).not.toContain("EXECUTION_COMPLETED");
  }, 20_000);

  it("an execution resumed past its deadline never rotates: the chain cannot outlive it", async () => {
    const h = build(on);
    const f = flow<{ gen?: number }, unknown>("dl2", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      return "never";
    });
    f.definition.deadlineMs = 80;
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "dl2" }));
    await new Promise((r) => setTimeout(r, 120));
    await h.rt.send("dl2", { topic: "go", payload: 1 });
    await until(async () => (await status(h, "dl2")) === "cancelled", 3000);
    expect(await kinds(h.eventStore, "dl2")).not.toContain("EXECUTION_CONTINUED");
    expect(await h.eventStore.read("dl2~1")).toEqual([]);
  });
});

describe("ADR 0109 D1/D3 — what is NOT chain-wide", () => {
  it("each generation has its own flow hash and runs the CURRENT code", async () => {
    const h = build(on);
    const v1 = flow<{ gen?: number }, unknown>("ver", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      return "v1";
    });
    h.rt.registerFlow(v1.definition, v1.runner);
    await settle(await h.rt.start(v1, {}, { executionId: "v" }));
    // a deploy: the flow id is re-registered with new code before the rotation
    const v2 = flow<{ gen?: number }, unknown>(
      "ver",
      async (_ctx, input) => (input?.gen === undefined ? "?" : "v2"),
      "2.0.0"
    );
    h.rt.registerFlow(v2.definition, v2.runner);
    await h.rt.send("v", { topic: "go", payload: 1 }).catch(() => undefined);
    await until(async () => (await status(h, "v~1")) === "completed");
    expect((await h.rt.loadState("v~1"))?.variables._output).toBe("v2");
  });
});

describe("R11 carry-over — outcomes on a continued generation", () => {
  it("recordOutcome attaches to the generation that made the decision, which is terminal as `continued`", async () => {
    const h = build(on);
    const f = flow<{ gen?: number }, unknown>("oc", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.decide("route", () => "a");
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      await ctx.receive("never");
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "oc" }));
    // while the generation is live (parked) the late path is refused
    await expect(
      h.rt.recordOutcome("oc", { decisionId: "route", key: "k", score: 1 })
    ).rejects.toThrow(/FINISHED execution/);
    await h.rt.send("oc", { topic: "go", payload: 1 });
    await until(async () => (await status(h, "oc")) === "continued");
    const r = await h.rt.recordOutcome("oc", { decisionId: "route", key: "k", score: 1 });
    expect(r.appended).toBe(true);
    expect(
      (await h.rt.recordOutcome("oc", { decisionId: "route", key: "k", score: 1 })).appended
    ).toBe(false);
    expect(await status(h, "oc")).toBe("continued");
    // the head's log is untouched: the successor never made that decision
    await expect(
      h.rt.recordOutcome("oc~1", { decisionId: "route", key: "k", score: 1 })
    ).rejects.toThrow();
  });
});
void parkedOrDone;
