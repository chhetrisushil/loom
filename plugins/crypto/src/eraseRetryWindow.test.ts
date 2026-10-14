import { EraseCoordinator, SubjectIndex, exportSubject } from "@loom/compliance";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore, isKeyUnavailable } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingEventStore } from "./EncryptingEventStore";
import { InMemoryKeyStore } from "./keystore";
import { ShredIncompleteError, shredSubject } from "./shred";

// ADR 0130 D7 - the ShredIncomplete window: the key is destroyed but the tombstone append failed.
// There the log carries no PAYLOAD_SHREDDED yet, so a read is `KeyUnavailableError`; an erasure
// retry (and an export) must still complete idempotently rather than fail on that read.

const SENSITIVE = { STEP_COMPLETED: ["output.ssn"] };
const NO_SNAPSHOTS = { loadLatest: async () => null };

const ev = (sequence: number, eventType: string, payload: unknown): EventEnvelope => ({
  id: `e1-${sequence}`,
  workflowId: "wf",
  executionId: "e1",
  eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload,
});

async function windowWorld(onShredded: "throw" | "tolerate") {
  const inner = new InMemoryAsyncEventStore();
  const keys = new InMemoryKeyStore();
  const store = new EncryptingEventStore(inner, keys, { sensitive: SENSITIVE, onShredded });
  await store.append(ev(0, "EXECUTION_STARTED", { input: { userId: "ann" } }));
  await store.append(ev(1, "STEP_COMPLETED", { stepId: "s", output: { ssn: "123-45-6789" } }));
  await store.append(ev(2, "EXECUTION_COMPLETED", {}));
  let fail = true;
  const flaky = Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
    append: async (e: EventEnvelope) => {
      if (e.eventType === "PAYLOAD_SHREDDED" && fail) {
        fail = false;
        throw new Error("write conflict");
      }
      return inner.append(e);
    },
  });
  const index = SubjectIndex.fromEvents(await store.read("e1"), (e) =>
    e.eventType === "EXECUTION_STARTED"
      ? (e.payload as { input?: { userId?: string } }).input?.userId
      : undefined
  );
  const shred = (subject: string, executionIds: readonly string[]) =>
    shredSubject(keys, flaky, "e1", {
      subjectId: "e1",
      executionIds: [...executionIds],
      snapshotStore: NO_SNAPSHOTS,
    });
  return { inner, keys, store, index, shred, subject: "ann" };
}

const tombstones = async (inner: InMemoryAsyncEventStore) =>
  (await inner.read("e1")).filter((e) => e.eventType === "PAYLOAD_SHREDDED");

describe("eraseSubject / exportSubject in the ShredIncomplete window", () => {
  for (const mode of ["throw", "tolerate"] as const) {
    it(`${mode}: the eraseSubject retry completes idempotently, with exactly one PAYLOAD_SHREDDED`, async () => {
      const w = await windowWorld(mode);
      const coord = new EraseCoordinator({
        index: w.index,
        eventStore: w.store,
        shred: w.shred,
      });
      await expect(coord.eraseSubject(w.subject)).rejects.toBeInstanceOf(ShredIncompleteError);
      expect(await tombstones(w.inner)).toHaveLength(0); // the window: key gone, no tombstone
      const retry = await coord.eraseSubject(w.subject);
      expect(retry.outcome).toBe("erased");
      expect(await tombstones(w.inner)).toHaveLength(1);
      // and a further retry stays idempotent
      expect((await coord.eraseSubject(w.subject)).outcome).toBe("erased");
      expect(await tombstones(w.inner)).toHaveLength(1);
    });

    it(`${mode}: exportSubject in the window returns the redacted export instead of failing`, async () => {
      const w = await windowWorld(mode);
      const coord = new EraseCoordinator({ index: w.index, eventStore: w.store, shred: w.shred });
      await expect(coord.eraseSubject(w.subject)).rejects.toBeInstanceOf(ShredIncompleteError);
      const out = await exportSubject(w.subject, { index: w.index, eventStore: w.store });
      expect(out.executions).toHaveLength(1);
      expect(JSON.stringify(out)).not.toContain("123-45-6789");
    });
  }
});

// ADR 0130 D7 (round 4) - the retry window needs DURABLE EVIDENCE that this erasure began. A node
// whose key store lacks the key (wrong key, partitioned key store) reads exactly like the window
// (key null, no tombstone) and must never be mistaken for it.
describe("a node that never had the key is not in the retry window", () => {
  async function wrongKeyWorld() {
    const w = await windowWorld("throw");
    const wrongKeys = new InMemoryKeyStore(); // the capable node's key is not here
    const wrongStore = new EncryptingEventStore(w.inner, wrongKeys, {
      sensitive: SENSITIVE,
      onShredded: "throw",
    });
    const shred = (_s: string, executionIds: readonly string[]) =>
      shredSubject(wrongKeys, w.inner, "e1", {
        subjectId: "e1",
        executionIds: [...executionIds],
        snapshotStore: NO_SNAPSHOTS,
      });
    return { ...w, wrongKeys, wrongStore, shred };
  }

  it("eraseSubject rejects, appends nothing, and leaves the capable node's key and data intact", async () => {
    const w = await wrongKeyWorld();
    const before = JSON.stringify(await w.inner.read("e1"));
    const coord = new EraseCoordinator({
      index: w.index,
      eventStore: w.wrongStore,
      shred: w.shred,
    });
    const err = await coord.eraseSubject(w.subject).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isKeyUnavailable(err)).toBe(true);
    expect(JSON.stringify(await w.inner.read("e1"))).toBe(before); // log identical
    expect(await w.keys.get("e1")).not.toBeNull(); // the capable node's key is intact
    const readable = await w.store.read("e1");
    expect(JSON.stringify(readable)).toContain("123-45-6789"); // and it still reads the data
  });

  it("shredSubject on that node refuses: no intent, no tombstone, nothing destroyed", async () => {
    const w = await wrongKeyWorld();
    const before = JSON.stringify(await w.inner.read("e1"));
    await expect(w.shred("ann", ["e1"])).rejects.toSatisfy(isKeyUnavailable);
    expect(JSON.stringify(await w.inner.read("e1"))).toBe(before);
    expect(await w.keys.get("e1")).not.toBeNull();
  });

  it("exportSubject rejects instead of returning a redacted export as if erased", async () => {
    const w = await wrongKeyWorld();
    await expect(
      exportSubject(w.subject, { index: w.index, eventStore: w.wrongStore })
    ).rejects.toSatisfy(isKeyUnavailable);
  });
});

describe("the erase intent makes the retry crash-safe at every point", () => {
  it("a crash after the intent but before the key's destruction: the retry completes", async () => {
    const w = await windowWorld("throw");
    let crash = true;
    const realDestroy = w.keys.destroy.bind(w.keys);
    w.keys.destroy = async (id: string) => {
      if (crash) {
        crash = false;
        throw new Error("crash before destroy");
      }
      return realDestroy(id);
    };
    const coord = new EraseCoordinator({ index: w.index, eventStore: w.store, shred: w.shred });
    await expect(coord.eraseSubject(w.subject)).rejects.toThrow("crash before destroy");
    expect(await w.keys.get("e1")).not.toBeNull(); // intent written, key still present
    const log = await w.inner.read("e1");
    expect(log.filter((e) => e.eventType === "ERASURE_PENDING")).toHaveLength(1);
    expect(await tombstones(w.inner)).toHaveLength(0);
    // the retry sees the key present: destroys it (the flaky store fails the FIRST tombstone), then
    // the window retry completes on the intent alone
    await expect(coord.eraseSubject(w.subject)).rejects.toBeInstanceOf(ShredIncompleteError);
    expect((await coord.eraseSubject(w.subject)).outcome).toBe("erased");
    expect(await tombstones(w.inner)).toHaveLength(1);
    expect(
      (await w.inner.read("e1")).filter((e) => e.eventType === "ERASURE_PENDING")
    ).toHaveLength(1);
  });
});
