import { describe, expect, it } from "vitest";
import { Latch, build, flow, kinds, settle, slow, until } from "./__tests__/r2Harness";
import type { Harness } from "./__tests__/r2Harness";
import {
  ChainHopLimitError,
  ContinuationConflictError,
  ReservedSuccessorIdError,
} from "./continuation";
import { executionAccessPolicy } from "./executionAccessPolicy";

// R1b fix round 3 (ADR 0109): the re-review's findings.

const on = { continueAsNewEnabled: true } as const;
const alice = { actor: "alice", tenant: "t1" };
const status = async (h: Harness, id: string) =>
  (await h.rt.loadState(id, h.rt.systemOptions()))?.status;
const parked = (h: Harness, id: string) => until(async () => (await status(h, id)) === "suspended");

const rotator = () =>
  flow<{ go?: boolean }, unknown>("rot", async (ctx, input) => {
    if (input?.go === true) return ctx.continueAsNew({ from: "input" });
    await ctx.suspend({ on: "hold" });
    return "done";
  });
const planted = (id: string, extra: Record<string, unknown> = {}) => ({
  id: `${id}-0`,
  workflowId: "deep",
  executionId: id,
  eventType: "EXECUTION_STARTED",
  sequence: 0,
  timestamp: 1,
  payload: { input: {}, ...extra },
});
const deep = (n: number) =>
  flow<{ g?: number }, unknown>("deep", async (ctx, input) => {
    const g = input?.g ?? 0;
    if (g < n) return ctx.continueAsNew({ g: g + 1 });
    await ctx.suspend({ on: "end" });
    return "end";
  });

describe("P2 - restoreFromState honours the successor-id reservation", () => {
  it("creates nothing at victim~1 / victim~5 / victim::g#0~1, and victim still rotates", async () => {
    const h = build(on);
    const f = rotator();
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "victim" }));
    await settle(await h.rt.start(f, {}, { executionId: "other" }));
    const base = (await h.rt.loadState("other"))!;
    for (const id of ["victim~1", "victim~5", "victim::g#0~1"]) {
      await expect(
        h.rt.restoreFromState({
          ...base,
          executionId: id,
          sequence: -1,
          variables: { _input: {} },
        } as never)
      ).rejects.toBeInstanceOf(ReservedSuccessorIdError);
      expect(await h.eventStore.read(id)).toEqual([]);
    }
    // the victim's own rotation is not poisoned
    const v = (await h.rt.loadState("victim"))!;
    const handle = await h.rt.restoreFromState({
      ...v,
      variables: { ...v.variables, _input: { go: true } },
    } as never);
    await handle.waitForCompletion().catch((e: unknown) => {
      expect(e).not.toBeInstanceOf(ContinuationConflictError);
    });
    await until(async () => (await kinds(h.eventStore, "victim")).includes("EXECUTION_CONTINUED"));
    expect((await h.eventStore.read("victim~1")).length).toBeGreaterThan(0);
  });
});

describe("P3-1 - the carry cannot be forged through a snapshot", () => {
  const meter = flow<{ go?: boolean }, unknown>("meter", async (ctx, input) => {
    if (input?.go === true) {
      // an append BEFORE the rotation: with snapshotEvery 1 it persists the restored vm state
      ctx.emit("RESOURCE_METERED", { tokens: 0 });
      return ctx.continueAsNew({ from: "input" });
    }
    ctx.emit("RESOURCE_METERED", { tokens: 7 });
    await ctx.suspend({ on: "hold" });
    return "done";
  });

  async function forgedRotation(forged: Record<string, unknown>, restoreOpts: object = {}) {
    const h = build({ ...on, snapshotEvery: 1 });
    h.rt.registerFlow(meter.definition, meter.runner);
    await settle(await h.rt.start(meter, {}, { executionId: "m" }));
    const s = (await h.rt.loadState("m"))!;
    const handle = await h.rt.restoreFromState(
      {
        ...s,
        ...forged.top,
        variables: { ...s.variables, ...forged.vars, _input: { go: true } },
      } as never,
      undefined,
      restoreOpts
    );
    await handle.waitForCompletion().catch(() => undefined);
    await until(async () => (await h.eventStore.read("m~1")).length > 0);
    return (
      (await h.eventStore.read("m~1"))[0]?.payload as {
        continuedFrom: {
          carried: {
            resources?: Record<string, unknown>;
            inbox?: { cursors: Record<string, number>; dedupe: string[] };
            chainDeadline?: number;
          };
        };
      }
    ).continuedFrom.carried;
  }

  it("forged _resources are replaced by the log's totals", async () => {
    const carried = await forgedRotation({
      vars: { _resources: { tokens: 1, costUsd: 0, ms: 0, count: 0, FORGED: true } },
    });
    expect(carried.resources?.tokens).toBe(7);
    expect(carried.resources).not.toHaveProperty("FORGED");
  });

  it("forged _inbox cursors and dedupe are dropped", async () => {
    const carried = await forgedRotation({
      vars: { _inbox: { cursors: { go: 999 }, dedupe: ["forged-key"] } },
    });
    expect(carried.inbox?.cursors?.go).toBeUndefined();
    expect(carried.inbox?.dedupe ?? []).not.toContain("forged-key");
  });

  it("a forged startedAt cannot move the chain deadline", async () => {
    const carried = await forgedRotation({ top: { startedAt: 5 } }, { deadlineMs: 100000 });
    expect(carried.chainDeadline).toBeGreaterThan(Date.now());
  });
});

describe("P3-2 - a mid-chain gap is a stated residual", () => {
  it("with c~1 deleted, the head is unreachable from c (clean refusal, nothing appended); a surviving id still works", async () => {
    const h = build(on);
    const f = deep(4);
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c" }));
    await parked(h, "c~4");
    await h.eventStore.deleteExecution?.("c~1");
    const before = await kinds(h.eventStore, "c");
    expect((await h.rt.followToHead("c"))?.executionId).toBe("c"); // no verified link out of c
    await expect(h.rt.resume("c", { eventType: "end", payload: 1 })).rejects.toThrow();
    expect(await kinds(h.eventStore, "c")).toEqual(before);
    expect(await kinds(h.eventStore, "c~4")).not.toContain("EXECUTION_RESUMED");
    expect((await h.rt.followToHead("c~2"))?.executionId).toBe("c~4"); // addressing a survivor works
  });
});

describe("P3-3 - test gaps", () => {
  it("(a) a squatter at c~1 naming c but owned by ANOTHER principal captures no send / cancel", async () => {
    const latch = new Latch();
    const h = build(on, { latch });
    const busy = flow<unknown, unknown>("busy", async (ctx) => {
      await ctx.run(slow, "x");
      await ctx.receive("go");
      return "done";
    });
    h.rt.registerFlow(busy.definition, busy.runner);
    await h.rt.start(busy, {}, { executionId: "c", principal: alice });
    await until(async () => (await kinds(h.eventStore, "c")).includes("STEP_STARTED"));
    await h.eventStore.append(
      planted("c~1", {
        chainId: "c",
        generation: 1,
        continuedFrom: { executionId: "c" },
        principal: { v: 1, identity: { actor: "mallory", tenant: "t2" } },
      })
    );
    const sent = await h.rt.send("c", { topic: "go", payload: 1, messageId: "m1" });
    expect(sent.executionId).toBe("c");
    expect(await h.rt.cancel("c", "stop")).toBe(true);
    latch.release();
    expect((await h.eventStore.read("c~1")).length).toBe(1);
  });

  it("(b) followToHead authorizes against the resolved head's owner too", async () => {
    const asked: string[] = [];
    const policy = executionAccessPolicy();
    const h = build({
      ...on,
      executionAuthorizer: {
        ...policy,
        authorize: (req: { executionId: string }) => {
          asked.push(req.executionId);
          return (policy.authorize as (r: unknown) => { allowed: boolean })(req);
        },
      } as never,
      executionAuthz: { requirePrincipal: true },
    });
    const f = deep(3);
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c", principal: alice }));
    await parked(h, "c~3");
    asked.length = 0;
    expect((await h.rt.followToHead("c", { principal: alice }))?.executionId).toBe("c~3");
    expect(asked[0]).toBe("c");
    expect(asked).toContain("c~3");
  });

  it("(c) a deepest log that fails verification on a chain longer than maxChainHops refuses with ChainHopLimitError, never a clean cancel", async () => {
    const h = build({ ...on, maxChainHops: 4 });
    const f = deep(12);
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c" }));
    await parked(h, "c~12");
    await h.eventStore.append(
      planted("c~13", { chainId: "c", generation: 13, continuedFrom: { executionId: "elsewhere" } })
    );
    const refusal = async (p: Promise<unknown>) => {
      const e = await p.then(() => undefined).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ChainHopLimitError);
      expect((e as ChainHopLimitError).reached).toBe("c~4");
    };
    await refusal(h.rt.followToHead("c"));
    await refusal(h.rt.resume("c", { eventType: "end", payload: 1 }));
    await refusal(h.rt.cancel("c", "stop"));
    await refusal(h.rt.send("c", { topic: "go", payload: 1 }));
    expect(await status(h, "c~12")).toBe("suspended"); // nothing was cancelled or resumed
  });
});
