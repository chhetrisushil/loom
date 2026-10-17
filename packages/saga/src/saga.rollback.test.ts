import { StorageWriteError, SuspendError, step$ } from "@loom/core";
import {
  ExecutionCancelledError,
  ExecutionStoreUnavailableError,
  FlowDivergenceError,
  LeaseHeldError,
  LeaseLostError,
  SealedPayloadUnreadableError,
  StartFencedOutError,
  StartLeaseHeldError,
} from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SagaCompensationError, createSaga, withSaga } from "./saga";

const empty = z.object({});
const mk = (id: string) =>
  step$({ id, name: id, toolId: id, inputSchema: empty, outputSchema: empty });
const fwd = mk("fwd");
const undoA = mk("undo-a");
const undoB = mk("undo-b");
const undoC = mk("undo-c");

type Script = Record<string, () => unknown>;

/** A fake ctx whose `run` records the (derived) step id and executes a per-toolId script. */
function fakeCtx(script: Script) {
  const ran: string[] = [];
  const ctx = {
    async run(step: { id: string; toolId?: string }) {
      ran.push(step.id);
      const fn = script[step.toolId ?? step.id];
      if (fn) await fn();
      return {};
    },
  };
  return { ctx: ctx as never, ran };
}

async function registerThree(saga: ReturnType<typeof createSaga>) {
  saga.compensate(undoA, {});
  saga.compensate(undoB, {});
  saga.compensate(undoC, {});
}

describe("rollback: runtime signals propagate unwrapped (no masking)", () => {
  const signals: [string, () => unknown][] = [
    ["cancellation", () => new ExecutionCancelledError()],
    ["abort", () => new DOMException("aborted", "AbortError")],
    ["lost lease", () => new LeaseLostError("exec", "node-1", "taken-over")],
    ["stale fence", () => Object.assign(new Error("stale fence"), { name: "StaleFenceError" })],
    [
      "divergence",
      () =>
        new FlowDivergenceError("exec", "w", { kind: "a", name: "b" }, { kind: "c", name: "d" }),
    ],
    ["storage failure", () => new StorageWriteError(new Error("disk"))],
    ["store unavailable", () => new ExecutionStoreUnavailableError("resume" as never, "exec")],
    ["lease held elsewhere", () => new LeaseHeldError("exec")],
    ["sealed payload", () => new SealedPayloadUnreadableError("exec", "msg", "topic")],
    ["start fenced out", () => new StartFencedOutError("exec")],
    ["start lease held", () => new StartLeaseHeldError("exec")],
    ["suspension", () => new SuspendError({ type: "event", eventType: "approve" } as never)],
  ];
  for (const [name, make] of signals) {
    it(`${name} during rollback propagates as-is and stops the remaining compensators`, async () => {
      const signal = make();
      const { ctx, ran } = fakeCtx({
        "undo-b": () => {
          throw signal;
        },
      });
      const saga = createSaga(ctx);
      await registerThree(saga);
      const err = await saga.rollback().catch((e: unknown) => e);
      expect(err).toBe(signal); // not wrapped in SagaCompensationError
      // reverse order: undo-c ran, undo-b raised the signal, undo-a never ran
      expect(ran).toEqual(["undo-c#compensate:2", "undo-b#compensate:1"]);
    });
  }

  it("a plain Error that merely NAMES itself AbortError is a compensator failure, not an abort", async () => {
    const spoof = Object.assign(new Error("not an abort"), { name: "AbortError" });
    const { ctx, ran } = fakeCtx({
      "undo-b": () => {
        throw spoof;
      },
    });
    const saga = createSaga(ctx);
    await registerThree(saga);
    const err = await saga.rollback().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SagaCompensationError);
    expect((err as SagaCompensationError).compensationErrors).toEqual([spoof]);
    expect(ran).toHaveLength(3); // the remaining compensators still ran
  });

  it("through withSaga the signal replaces nothing and is not a SagaCompensationError", async () => {
    const cancel = new ExecutionCancelledError();
    const { ctx, ran } = fakeCtx({
      "undo-a": () => {
        throw cancel;
      },
    });
    const err = await withSaga(ctx, async (saga) => {
      saga.compensate(undoA, {});
      throw new Error("forward failed");
    }).catch((e: unknown) => e);
    expect(err).toBe(cancel);
    expect(ran).toEqual(["undo-a#compensate:0"]);
  });

  it("a compensator's OWN failure is still collected and the rest still run", async () => {
    const own = new Error("undo-b broke");
    const { ctx, ran } = fakeCtx({
      "undo-b": () => {
        throw own;
      },
    });
    const saga = createSaga(ctx);
    await registerThree(saga);
    const err = await saga.rollback().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SagaCompensationError);
    expect((err as SagaCompensationError).compensationErrors).toEqual([own]);
    expect(ran).toHaveLength(3);
  });
});

describe("createSaga().rollback() direct path", () => {
  it("a failed rollback throws SagaCompensationError with NO cause", async () => {
    const { ctx } = fakeCtx({
      "undo-a": () => {
        throw new Error("nope");
      },
    });
    const saga = createSaga(ctx);
    saga.compensate(undoA, {});
    const err = (await saga.rollback().catch((e: unknown) => e)) as SagaCompensationError;
    expect(err).toBeInstanceOf(SagaCompensationError);
    expect("cause" in err).toBe(false);
    expect(err.compensationErrors).toHaveLength(1);
  });

  it("is idempotent: a second rollback() after a failure is a no-op (runs and throws nothing)", async () => {
    const { ctx, ran } = fakeCtx({
      "undo-a": () => {
        throw new Error("nope");
      },
    });
    const saga = createSaga(ctx);
    saga.compensate(undoA, {});
    await expect(saga.rollback()).rejects.toBeInstanceOf(SagaCompensationError);
    await expect(saga.rollback()).resolves.toBeUndefined();
    expect(ran).toHaveLength(1);
  });

  it("a rollback with nothing registered resolves; pending reflects the stack", async () => {
    const { ctx, ran } = fakeCtx({});
    const saga = createSaga(ctx);
    expect(saga.pending).toBe(0);
    await saga.rollback();
    expect(ran).toEqual([]);
    await saga.run(fwd, {}, undoA);
    expect(saga.pending).toBe(1);
  });
});

describe("SagaCompensationError cause", () => {
  it("keeps the original as cause even when the original thrown value is undefined", async () => {
    const { ctx } = fakeCtx({
      "undo-a": () => {
        throw new Error("nope");
      },
    });
    const err = (await withSaga(ctx, async (saga) => {
      saga.compensate(undoA, {});
      throw undefined;
    }).catch((e: unknown) => e)) as SagaCompensationError;
    expect(err).toBeInstanceOf(SagaCompensationError);
    expect("cause" in err).toBe(true);
    expect(err.cause).toBeUndefined();
  });
});
