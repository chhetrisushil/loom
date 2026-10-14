import { EraseCoordinator, SubjectIndex, exportSubject } from "@loom/compliance";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
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
