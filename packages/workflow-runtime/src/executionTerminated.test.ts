import { describe, expect, it } from "vitest";
import { build, echo, flow, until } from "./__tests__/r2Harness";
import { ExecutionTerminatedError } from "./index";
import type { ExecutionHandle } from "./types";

// Issue #710 - `waitForSuspend()` settles on a park. On a run that ENDS without parking it used to
// stay pending forever; it now rejects with `ExecutionTerminatedError`, after `waitForCompletion()`
// has settled, in every terminal path (completion, failure, cancel, continue-as-new).

const caught = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
};

describe("ExecutionHandle.waitForSuspend on a terminal run (#710)", () => {
  it("rejects with the completed state when the run completes", async () => {
    const h = build();
    const f = flow("done", async (ctx) => ctx.run(echo, { n: 1 }));
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, { n: 1 }, { executionId: "c" });
    const done = await handle.waitForCompletion();
    const err = await caught(handle.waitForSuspend());
    expect(err).toBeInstanceOf(ExecutionTerminatedError);
    const e = err as ExecutionTerminatedError;
    expect(e.status).toBe("completed");
    expect(e.state).toEqual(done);
    expect(e.cause).toBeUndefined();
  });

  it("rejects with the failure as cause when the run fails", async () => {
    const h = build();
    const boom = new Error("boom");
    const f = flow("fails", async () => {
      throw boom;
    });
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "f" });
    const completion = await caught(handle.waitForCompletion());
    expect(completion).toBe(boom);
    const err = (await caught(handle.waitForSuspend())) as ExecutionTerminatedError;
    expect(err).toBeInstanceOf(ExecutionTerminatedError);
    expect(err.status).toBe("failed");
    expect(err.cause).toBe(boom);
    expect(err.state.executionId).toBe("f");
  });

  it("rejects when the run is cancelled", async () => {
    const h = build();
    const f = flow("cancelled", async (ctx) => {
      await ctx.suspend({ on: "never" });
    });
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "x" });
    // park first, then resume into a run that we cancel mid-flight
    await handle.waitForSuspend();
    const live = await h.rt.resume("x", { eventType: "never", payload: 1 });
    live.cancel("stop");
    const completion = await caught(live.waitForCompletion());
    const err = (await caught(live.waitForSuspend())) as ExecutionTerminatedError;
    expect(err).toBeInstanceOf(ExecutionTerminatedError);
    expect(err.status).toBe("cancelled");
    expect(err.cause).toBe(completion);
  });

  it("rejects on continue-as-new with the continued state", async () => {
    const h = build({ continueAsNewEnabled: true });
    const f = flow<{ gen?: number }, unknown>("now", async (ctx, input) =>
      input?.gen === undefined ? ctx.continueAsNew({ gen: 1 }) : "head"
    );
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "n" });
    const done = await handle.waitForCompletion();
    expect(done.status).toBe("continued");
    const err = (await caught(handle.waitForSuspend())) as ExecutionTerminatedError;
    expect(err).toBeInstanceOf(ExecutionTerminatedError);
    expect(err.status).toBe("continued");
    expect(err.state.variables._continuedTo).toBe("n~1");
    await until(async () => (await h.rt.loadState("n~1"))?.status === "completed");
  });

  it("still RESOLVES on a park", async () => {
    const h = build();
    const f = flow("parks", async (ctx) => {
      await ctx.suspend({ on: "go" });
      return "ok";
    });
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "p" });
    expect((await handle.waitForSuspend()).status).toBe("suspended");
    const resumed = await h.rt.resume("p", { eventType: "go", payload: 1 });
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    await expect(resumed.waitForSuspend()).rejects.toBeInstanceOf(ExecutionTerminatedError);
  });

  it("a race of the two settles on the completion, in either order", async () => {
    const h = build();
    const f = flow("race", async () => "out");
    h.rt.registerFlow(f.definition, f.runner);
    const a: ExecutionHandle = await h.rt.start(f, {}, { executionId: "r1" });
    const b: ExecutionHandle = await h.rt.start(f, {}, { executionId: "r2" });
    expect((await Promise.race([a.waitForCompletion(), a.waitForSuspend()])).status).toBe(
      "completed"
    );
    expect((await Promise.race([b.waitForSuspend(), b.waitForCompletion()])).status).toBe(
      "completed"
    );
  });

  it("raises no unhandled rejection when waitForSuspend is never called", async () => {
    const seen: unknown[] = [];
    const on = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", on);
    try {
      const h = build();
      const ok = flow("ok", async () => "x");
      const bad = flow("bad", async () => {
        throw new Error("nope");
      });
      h.rt.registerFlow(ok.definition, ok.runner);
      h.rt.registerFlow(bad.definition, bad.runner);
      const a = await h.rt.start(ok, {}, { executionId: "u1" });
      const b = await h.rt.start(bad, {}, { executionId: "u2" });
      await a.waitForCompletion();
      await caught(b.waitForCompletion());
      // unhandled rejections are reported after the microtask queue drains and a macrotask turn
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });

  it("keeps the plaintext state out of serialisation but readable as err.state", async () => {
    const h = build();
    const f = flow("secret", async () => "super-secret-output");
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "s" });
    await handle.waitForCompletion();
    const err = (await caught(handle.waitForSuspend())) as ExecutionTerminatedError;
    expect(err.state.executionId).toBe("s");
    expect(Object.keys(err)).not.toContain("state");
    expect(Object.keys(err)).toContain("status");
    const json = JSON.stringify(err);
    expect(json).not.toContain("state");
    expect(json).not.toContain("super-secret-output");
    expect(json).toContain("completed");
  });
});
