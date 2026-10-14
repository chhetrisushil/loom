import type { ExecutionState } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { Snapshot } from "@loom/snapshot-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingEventStore } from "./EncryptingEventStore";
import { EncryptingSnapshotStore } from "./EncryptingSnapshotStore";
import { PayloadShreddedError } from "./errors";
import { InMemoryKeyStore } from "./keystore";
import { shredSubject } from "./shred";

// ADR 0130 D8 (residual b, 1P) — `sealState: true` seals the WHOLE folded state as one
// envelope, covering the dynamic `variables._waitAnswers.<waitId>` keys no static path can name.

const WAIT_SECRET = "hunter2-wait-answer";
const INPUT_SECRET = "123-45-6789";

function snapshot(executionId = "e1", sequence = 3): Snapshot {
  const state = {
    executionId,
    workflowId: "wf",
    workflowVersion: "1.0.0",
    status: "suspended",
    frames: {},
    variables: {
      _input: { ssn: INPUT_SECRET },
      _waitAnswers: { "wait-dynamic-77": { answer: WAIT_SECRET } },
    },
    sequence,
    startedAt: 0,
    updatedAt: 0,
  } as unknown as ExecutionState;
  return { id: `s-${sequence}`, executionId, workflowId: "wf", sequence, state, createdAt: 5 };
}

function make() {
  const inner = new InMemoryAsyncSnapshotStore();
  const keys = new InMemoryKeyStore();
  const snaps = new EncryptingSnapshotStore(inner, keys, { sealState: true });
  return { inner, keys, snaps };
}

describe("EncryptingSnapshotStore sealState (ADR 0130 D8)", () => {
  it("exposes the structural sealsWholeState marker, and only in sealState mode", () => {
    const { snaps, keys } = make();
    expect((snaps as { sealsWholeState?: unknown }).sealsWholeState).toBe(true);
    const legacy = new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), keys, {
      sensitive: ["variables._input.ssn"],
    });
    expect((legacy as { sealsWholeState?: unknown }).sealsWholeState).not.toBe(true);
  });

  it("hides dynamic _waitAnswers values: no plaintext anywhere in the stored snapshot", async () => {
    const { snaps, inner } = make();
    await snaps.save(snapshot());
    const raw = (await inner.loadLatest("e1")) as Snapshot;
    // JSON-quoted values: random base64 can contain short bare substrings (loom #581).
    const bytes = JSON.stringify(raw);
    expect(bytes).not.toContain(JSON.stringify(WAIT_SECRET));
    expect(bytes).not.toContain(WAIT_SECRET);
    expect(bytes).not.toContain(JSON.stringify(INPUT_SECRET));
    expect(bytes).not.toContain("_waitAnswers");
    expect(bytes).not.toContain("wait-dynamic-77");
    // Whole state is ONE envelope; the index fields stay in the clear.
    expect(raw.state).toMatchObject({ __loomEnc: "loom/aes-256-gcm" });
    expect(raw).toMatchObject({ id: "s-3", executionId: "e1", workflowId: "wf", sequence: 3 });
  });

  it("round-trips through loadLatest, loadAt and loadLatestBefore", async () => {
    const { snaps } = make();
    const snap = snapshot();
    await snaps.save(snap);
    expect((await snaps.loadLatest("e1"))?.state).toEqual(snap.state);
    expect((await snaps.loadAt("e1", 3))?.state).toEqual(snap.state);
    expect((await snaps.loadLatestBefore("e1", 9))?.state).toEqual(snap.state);
    expect(await snaps.loadLatest("nope")).toBeNull();
  });

  it("a shredded subject makes the snapshot unreadable, like the event payloads", async () => {
    const innerEvents = new InMemoryAsyncEventStore();
    const inner = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(innerEvents, keys, {
      sensitive: { STEP_COMPLETED: ["output.ssn"] },
    });
    const snaps = new EncryptingSnapshotStore(inner, keys, { sealState: true });
    await events.append({
      id: "e1-0",
      workflowId: "wf",
      executionId: "e1",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      payload: { stepId: "s", output: { ssn: INPUT_SECRET } },
      timestamp: 0,
    } as never);
    await snaps.save(snapshot());
    await shredSubject(keys, innerEvents, "e1", { snapshotStore: snaps });
    await expect(snaps.loadLatest("e1")).rejects.toBeInstanceOf(PayloadShreddedError);
    await expect(snaps.loadAt("e1", 3)).rejects.toBeInstanceOf(PayloadShreddedError);
    await expect(events.read("e1")).rejects.toBeInstanceOf(PayloadShreddedError);
    // The at-rest read still answers (sequence only) and holds no plaintext.
    const sealed = await snaps.loadLatestSealed("e1");
    expect(sealed?.sequence).toBe(3);
    expect(JSON.stringify(sealed)).not.toContain(WAIT_SECRET);
  });

  it("loads a legacy plaintext snapshot as-is, and re-seals it on the next save", async () => {
    const { snaps, inner } = make();
    await inner.save(snapshot("old", 1)); // written by a store without sealState
    const loaded = await snaps.loadLatest("old");
    expect(loaded?.state).toEqual(snapshot("old", 1).state);
    await snaps.save({ ...(loaded as Snapshot), id: "s-2", sequence: 2 });
    const raw = (await inner.loadLatest("old")) as Snapshot;
    expect(raw.sequence).toBe(2);
    expect(JSON.stringify(raw)).not.toContain(WAIT_SECRET);
  });

  it("a sealState store opens a snapshot written with static sensitive paths", async () => {
    const inner = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const staticStore = new EncryptingSnapshotStore(inner, keys, {
      sensitive: ["variables._input.ssn"],
    });
    await staticStore.save(snapshot("st", 1));
    const sealer = new EncryptingSnapshotStore(inner, keys, { sealState: true });
    expect((await sealer.loadLatest("st"))?.state).toEqual(snapshot("st", 1).state);
  });

  it("a snapshot written with sealState still loads through a static-path store (same keys)", async () => {
    const { snaps, inner, keys } = make();
    await snaps.save(snapshot());
    const staticStore = new EncryptingSnapshotStore(inner, keys, {
      sensitive: ["variables._input.ssn"],
    });
    expect((await staticStore.loadLatest("e1"))?.state).toEqual(snapshot().state);
  });

  it("registerSensitive is a no-op in sealState mode (everything is already sealed)", async () => {
    const { snaps, inner } = make();
    snaps.registerSensitive(["variables._principal.identity.id"]);
    await snaps.save(snapshot());
    const raw = (await inner.loadLatest("e1")) as Snapshot;
    expect(raw.state).toMatchObject({ __loomEnc: "loom/aes-256-gcm" });
  });

  it("sealState together with sensitive is a config error", () => {
    expect(
      () =>
        new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), new InMemoryKeyStore(), {
          sealState: true,
          sensitive: ["variables._input.ssn"],
        } as never)
    ).toThrow(/sealState.*sensitive|sensitive.*sealState/);
  });

  it("refuses an empty subject, as the static mode does", async () => {
    const { inner, keys } = make();
    const snaps = new EncryptingSnapshotStore(inner, keys, {
      sealState: true,
      subjectOf: () => "",
    });
    await expect(snaps.save(snapshot())).rejects.toBeInstanceOf(TypeError);
  });
});
