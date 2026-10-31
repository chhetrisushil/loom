import { StorageWriteError } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryLeaseStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { WorkflowRuntime, type WorkflowRuntimeDeps } from "./WorkflowRuntime";
import { build, echo, flow } from "./__tests__/r2Harness";
import { ExecutionTerminatedError } from "./index";
import type { ExecutionHandle } from "./types";

// Issue #710 follow-up - ordering and failure paths of `waitForSuspend()`.
// (1) completion wins a race with `waitForSuspend()` whether the caller attached before or after the
//     run settled, in either array order; (5) the storage-failure rejects and the leased settle path.

const macrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 15));
const settleEnough = async (): Promise<void> => {
  await macrotask();
};

type Attach = "immediate" | "after-macrotask";
const attaches: Attach[] = ["immediate", "after-macrotask"];

async function raceBoth(
  mk: () => Promise<ExecutionHandle>,
  attach: Attach,
  suspendFirst: boolean
): Promise<unknown> {
  const h = await mk();
  if (attach === "after-macrotask") await settleEnough();
  try {
    return await Promise.race(
      suspendFirst
        ? [h.waitForSuspend(), h.waitForCompletion()]
        : [h.waitForCompletion(), h.waitForSuspend()]
    );
  } catch (e) {
    return { rejected: e };
  }
}

describe("waitForSuspend vs waitForCompletion race (#710)", () => {
  for (const attach of attaches) {
    for (const suspendFirst of [true, false]) {
      const label = `${attach}, ${suspendFirst ? "suspend" : "completion"} first`;
      it(`a completing flow resolves the completion (${label})`, async () => {
        const h = build();
        const f = flow("c", async (ctx) => ctx.run(echo, { n: 1 }));
        h.rt.registerFlow(f.definition, f.runner);
        const out = (await raceBoth(
          () => h.rt.start(f, {}, { executionId: "c" }),
          attach,
          suspendFirst
        )) as { status: string };
        expect(out.status).toBe("completed");
      });

      it(`a failing flow surfaces the ORIGINAL error (${label})`, async () => {
        const h = build();
        const boom = new Error("boom");
        const f = flow("f", async () => {
          throw boom;
        });
        h.rt.registerFlow(f.definition, f.runner);
        const out = (await raceBoth(
          () => h.rt.start(f, {}, { executionId: "f" }),
          attach,
          suspendFirst
        )) as { rejected: unknown };
        expect(out.rejected).toBe(boom);
      });
    }
  }

  it("waitForSuspend still rejects with ExecutionTerminatedError on its own, after settling", async () => {
    const h = build();
    const f = flow("own", async () => "x");
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "own" });
    await handle.waitForCompletion();
    await expect(handle.waitForSuspend()).rejects.toBeInstanceOf(ExecutionTerminatedError);
  });
});

describe("waitForSuspend on a storage failure (#710)", () => {
  it("rejects with the write error when a durable write fails mid-run (journal.failed drain)", async () => {
    const eventStore = new InMemoryAsyncEventStore({
      failAppendWhen: (e) => e.eventType === "STEP_COMPLETED",
    });
    const h = build({}, { eventStore });
    const f = flow("w", async (ctx) => ctx.run(echo, { n: 1 }));
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "w" });
    await expect(handle.waitForSuspend()).rejects.toBeInstanceOf(StorageWriteError);
    await expect(handle.waitForCompletion()).rejects.toBeInstanceOf(StorageWriteError);
  });

  it("rejects with the write error when EXECUTION_FAILED is not durable", async () => {
    const eventStore = new InMemoryAsyncEventStore({
      failAppendWhen: (e) => e.eventType === "EXECUTION_FAILED",
    });
    const h = build({}, { eventStore });
    const f = flow("nd", async () => {
      throw new Error("flow broke");
    });
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "nd" });
    const sus = await handle.waitForSuspend().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(sus).toBeInstanceOf(StorageWriteError);
    expect(sus).not.toBeInstanceOf(ExecutionTerminatedError);
    await expect(handle.waitForCompletion()).rejects.toBeInstanceOf(StorageWriteError);
  });
});

describe("waitForSuspend on a lease-wired runtime (#710)", () => {
  function leased() {
    const effects = new EffectRuntime();
    effects.register("echo", new ToolEffect(async (i: unknown) => i));
    const t = 1_700_000_000_000;
    const rt = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      inboxEnabled: true,
      now: () => t,
      heartbeat: {
        leaseStore: new InMemoryLeaseStore({ now: () => t }),
        acquire: "eager" as const,
        nodeId: "n1",
        incarnation: "i1",
        ttlMs: 30_000,
        monotonicNow: () => 1_000,
        wallNow: () => t,
        every: () => () => {},
      },
    } as unknown as WorkflowRuntimeDeps);
    return rt;
  }

  for (const attach of attaches) {
    for (const suspendFirst of [true, false]) {
      const label = `${attach}, ${suspendFirst ? "suspend" : "completion"} first`;
      it(`completion wins the race (${label})`, async () => {
        const rt = leased();
        const f = flow("lc", async (ctx) => ctx.run(echo, { n: 1 }));
        rt.registerFlow(f.definition, f.runner);
        const out = (await raceBoth(
          () => rt.start(f, {}, { executionId: "lc" }),
          attach,
          suspendFirst
        )) as { status: string };
        expect(out.status).toBe("completed");
      });
    }
  }

  it("rejects with ExecutionTerminatedError on a terminal run, and the original error wins a failing race", async () => {
    const rt = leased();
    const boom = new Error("leased boom");
    const f = flow("lf", async () => {
      throw boom;
    });
    rt.registerFlow(f.definition, f.runner);
    const handle = await rt.start(f, {}, { executionId: "lf" });
    const err = await handle.waitForSuspend().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ExecutionTerminatedError);
    expect((err as ExecutionTerminatedError).cause).toBe(boom);
    await expect(handle.waitForCompletion()).rejects.toBe(boom);
  });
});
