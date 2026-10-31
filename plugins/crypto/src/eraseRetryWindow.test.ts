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
        destroyed: (s) => w.keys.wasDestroyed(s),
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
      const coord = new EraseCoordinator({
        index: w.index,
        eventStore: w.store,
        shred: w.shred,
        destroyed: (s) => w.keys.wasDestroyed(s),
      });
      await expect(coord.eraseSubject(w.subject)).rejects.toBeInstanceOf(ShredIncompleteError);
      const out = await exportSubject(w.subject, {
        index: w.index,
        eventStore: w.store,
        destroyed: (s) => w.keys.wasDestroyed(s),
      });
      expect(out.executions).toHaveLength(1);
      expect(JSON.stringify(out)).not.toContain("123-45-6789");
      // Explicit signal: no `unarchived` here because the log was read through the erasure window.
      expect(out.executions[0]!.erasureWindow).toBe(true);
      expect(out.executions[0]!.unarchived).toBeUndefined();
      // With an archive configured the same holds: the missing coverage is explained, not silent.
      const withArchive = await exportSubject(w.subject, {
        index: w.index,
        eventStore: w.store,
        destroyed: (s) => w.keys.wasDestroyed(s),
        archive: {
          archiveCoverage: async () => ({ unarchived: [] }),
          readWithArchive: async (id) => w.store.read(id),
        },
      });
      expect(withArchive.executions[0]!.erasureWindow).toBe(true);
      expect(withArchive.executions[0]!.unarchived).toBeUndefined();
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
    const coord = new EraseCoordinator({
      index: w.index,
      eventStore: w.store,
      shred: w.shred,
      destroyed: (s) => w.keys.wasDestroyed(s),
    });
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

// ADR 0130 D7 (round 5) - the log proves INTENT, never destruction. A DANGLING intent (node A wrote
// ERASURE_PENDING then crashed before keys.destroy; the key lives on A) plus a retry on a wrong-key
// node B must not complete: only the key store can prove it destroyed the key.
describe("a dangling intent on a wrong-key node is not proof of destruction", () => {
  async function danglingWorld() {
    const w = await windowWorld("throw");
    // node A: intent written, then the destroy crashed -> key alive on A
    const realDestroy = w.keys.destroy.bind(w.keys);
    w.keys.destroy = async () => {
      throw new Error("crash before destroy");
    };
    await expect(w.shred("ann", ["e1"])).rejects.toThrow("crash before destroy");
    w.keys.destroy = realDestroy;
    // node B: fresh key store, same raw log
    const bKeys = new InMemoryKeyStore();
    const bStore = new EncryptingEventStore(w.inner, bKeys, {
      sensitive: SENSITIVE,
      onShredded: "throw",
    });
    const bShred = (_s: string, ids: readonly string[], force?: boolean) =>
      shredSubject(bKeys, w.inner, "e1", {
        subjectId: "e1",
        executionIds: [...ids],
        snapshotStore: NO_SNAPSHOTS,
        ...(force && { force: "key-destroyed-elsewhere" as const }),
      });
    return { ...w, bKeys, bStore, bShred };
  }

  it("shredSubject refuses and writes nothing; A's key stays intact", async () => {
    const w = await danglingWorld();
    const before = JSON.stringify(await w.inner.read("e1"));
    await expect(w.bShred("ann", ["e1"])).rejects.toSatisfy(isKeyUnavailable);
    expect(JSON.stringify(await w.inner.read("e1"))).toBe(before);
    expect(await w.keys.get("e1")).not.toBeNull();
  });

  it("eraseSubject refuses on B", async () => {
    const w = await danglingWorld();
    const before = JSON.stringify(await w.inner.read("e1"));
    const coord = new EraseCoordinator({
      index: w.index,
      eventStore: w.bStore,
      shred: (_s, ids) => w.bShred("ann", ids),
      destroyed: (s) => w.bKeys.wasDestroyed(s),
    });
    await expect(coord.eraseSubject(w.subject)).rejects.toSatisfy(isKeyUnavailable);
    expect(JSON.stringify(await w.inner.read("e1"))).toBe(before);
    expect(await w.keys.get("e1")).not.toBeNull();
  });

  it("exportSubject refuses on B", async () => {
    const w = await danglingWorld();
    await expect(
      exportSubject(w.subject, {
        index: w.index,
        eventStore: w.bStore,
        destroyed: (s) => w.bKeys.wasDestroyed(s),
      })
    ).rejects.toSatisfy(isKeyUnavailable);
  });

  it("the node that destroyed the key (wasDestroyed true) completes with exactly one tombstone", async () => {
    const w = await windowWorld("throw");
    const coord = new EraseCoordinator({
      index: w.index,
      eventStore: w.store,
      shred: w.shred,
      destroyed: (s) => w.keys.wasDestroyed(s),
    });
    await expect(coord.eraseSubject(w.subject)).rejects.toBeInstanceOf(ShredIncompleteError);
    expect(await w.keys.wasDestroyed("e1")).toBe(true);
    const out = await exportSubject(w.subject, {
      index: w.index,
      eventStore: w.store,
      destroyed: (s) => w.keys.wasDestroyed(s),
    });
    expect(out.executions).toHaveLength(1);
    expect((await coord.eraseSubject(w.subject)).outcome).toBe("erased");
    expect(await tombstones(w.inner)).toHaveLength(1);
  });

  it("a key store WITHOUT wasDestroyed in the window refuses, then completes with the force option", async () => {
    const w = await windowWorld("throw");
    // the destroying node's store, stripped of the proof method
    const bare = {
      getOrCreate: (s: string) => w.keys.getOrCreate(s),
      get: (s: string) => w.keys.get(s),
      destroy: (s: string) => w.keys.destroy(s),
    };
    const raw = Object.assign(Object.create(w.inner) as InMemoryAsyncEventStore, {
      append: (e: EventEnvelope) => w.inner.append(e),
    });
    const run = (force?: boolean) =>
      shredSubject(bare, raw, "e1", {
        subjectId: "e1",
        executionIds: ["e1"],
        snapshotStore: NO_SNAPSHOTS,
        ...(force && { force: "key-destroyed-elsewhere" as const }),
      });
    // first attempt: tombstone write fails -> window (key gone, intent present)
    await expect(w.shred("ann", ["e1"])).rejects.toBeInstanceOf(ShredIncompleteError);
    const before = JSON.stringify(await w.inner.read("e1"));
    await expect(run()).rejects.toSatisfy(isKeyUnavailable);
    expect(JSON.stringify(await w.inner.read("e1"))).toBe(before);
    await run(true);
    expect(await tombstones(w.inner)).toHaveLength(1);
  });
});
