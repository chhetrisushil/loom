import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { SealGuardedSnapshotStore, opaqueToQuarantineFold } from "./sealGuard";
import { assertNotTransientFold, isTransientFold, markTransientFold } from "./transientFold";

// User ruling 2026-10-14: a state folded past sealed payloads is TRANSIENT - decide-the-verb only.
describe("transient fold brand", () => {
  const state = () => ({ executionId: "x", variables: { v: 1 } }) as never;

  it("marks and freezes a state; unmarked states are not transient", () => {
    const s = markTransientFold(state());
    expect(isTransientFold(s)).toBe(true);
    expect(Object.isFrozen(s)).toBe(true);
    expect(isTransientFold(state())).toBe(false);
    expect(() => assertNotTransientFold(s, "somewhere")).toThrow(/transient/i);
    expect(() => assertNotTransientFold(state(), "somewhere")).not.toThrow();
  });

  it("the guarded snapshot store refuses to save a transient state", async () => {
    const inner = new InMemoryAsyncSnapshotStore();
    const guarded = new SealGuardedSnapshotStore(inner, async () => undefined);
    const t = markTransientFold(state());
    await expect(
      guarded.save({
        id: "i",
        executionId: "x",
        workflowId: "w",
        sequence: 1,
        state: t,
        createdAt: 0,
      } as never)
    ).rejects.toThrow(/transient/i);
    expect(await inner.loadLatest("x")).toBeNull();
  });
});

describe("opaqueToQuarantineFold: the exact covered-field rule", () => {
  const env = (
    eventType: string,
    covers: string[],
    payload: unknown = {
      waitId: "w",
      topic: "a",
      messageId: "m",
      inboxSeq: 0,
      payload: { __loomEnc: "x" },
    }
  ) => ({ eventType, payload }) as never;
  const marker = (covers: string[]) => ({ v: 1, cipher: "c", covers }) as never;

  it("admits only MESSAGE_CONSUMED whose covers are payload / payload.*", () => {
    expect(
      opaqueToQuarantineFold(env("MESSAGE_CONSUMED", []), marker(["MESSAGE_CONSUMED.payload"]))
    ).toBe(true);
    expect(
      opaqueToQuarantineFold(env("MESSAGE_CONSUMED", []), marker(["MESSAGE_CONSUMED.payload.ssn"]))
    ).toBe(true);
  });

  it("refuses any other covered path, other event type, empty covers, or a sealed routing field", () => {
    const mc = env("MESSAGE_CONSUMED", []);
    expect(
      opaqueToQuarantineFold(mc, marker(["MESSAGE_CONSUMED.payload", "MESSAGE_CONSUMED.topic"]))
    ).toBe(false);
    expect(opaqueToQuarantineFold(mc, marker(["MESSAGE_CONSUMED.payloadX"]))).toBe(false);
    expect(opaqueToQuarantineFold(mc, marker(["STEP_COMPLETED.output"]))).toBe(false);
    expect(opaqueToQuarantineFold(mc, marker([]))).toBe(false);
    expect(
      opaqueToQuarantineFold(env("STEP_COMPLETED", []), marker(["STEP_COMPLETED.output"]))
    ).toBe(false);
    expect(
      opaqueToQuarantineFold(env("INBOX_QUARANTINED", []), marker(["INBOX_QUARANTINED.payload"]))
    ).toBe(false);
    const sealedTopic = env("MESSAGE_CONSUMED", [], {
      waitId: "w",
      topic: { __loomEnc: "x" },
      messageId: "m",
      inboxSeq: 0,
    });
    expect(opaqueToQuarantineFold(sealedTopic, marker(["MESSAGE_CONSUMED.payload"]))).toBe(false);
  });
});
