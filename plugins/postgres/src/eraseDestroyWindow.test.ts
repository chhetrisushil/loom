import { EraseCoordinator, SubjectIndex } from "@loom/compliance";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import {
  type EventStore,
  INBOX_STREAM_PREFIX,
  InMemoryAsyncEventStore,
  isKeyUnavailable,
} from "@loom/event-runtime";
import {
  EncryptingSnapshotStore,
  InMemoryKeyStore,
  ShredIncompleteError,
  shredSubject,
} from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore, type SnapshotStore } from "@loom/snapshot-runtime";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";

// The erasure retry window with a SEALED snapshot (`sealState: true`): the key is destroyed (the
// ERASURE_PENDING intent is already in the log) but the PAYLOAD_SHREDDED tombstones are not
// written yet (a crash, a write conflict). The coordinator's fold must read the checkpoint through
// the erased-tolerant path, or `EncryptingSnapshotStore` throws KeyUnavailableError and the
// erasure can never finish. Run against memory always, and Postgres when LOOM_TEST_POSTGRES_URL is set.

const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const SUBJECT = "ann";

interface World {
  events: EventStore & { deleteExecution(id: string): Promise<void> };
  snapshots: SnapshotStore;
  cleanup(): Promise<void>;
}
interface Backend {
  name: string;
  make(): Promise<World>;
}

const memory: Backend = {
  name: "memory",
  make: async () => ({
    events: new InMemoryAsyncEventStore(),
    snapshots: new InMemoryAsyncSnapshotStore(),
    cleanup: async () => {},
  }),
};

const backends: Backend[] = [memory];
let admin: Pool | undefined;
let schemaSeq = 0;
if (PG_URL !== undefined) {
  backends.push({
    name: "postgres",
    make: async () => {
      const schema = `loom_erasewin_${process.pid}_${schemaSeq++}`;
      await (admin as Pool).query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await (admin as Pool).query(`CREATE SCHEMA ${schema}`);
      const pool = new Pool({
        connectionString: PG_URL,
        options: `-c search_path=${schema}`,
        max: 4,
      });
      return {
        events: new PostgresEventStore(pool),
        snapshots: new PostgresSnapshotStore(pool),
        cleanup: async () => {
          await pool.end();
          await (admin as Pool).query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        },
      };
    },
  });
}

beforeAll(async () => {
  if (PG_URL !== undefined) admin = new Pool({ connectionString: PG_URL, max: 1 });
}, 60_000);
afterAll(async () => {
  await admin?.end();
}, 60_000);

const ev = (sequence: number, eventType: string, payload: unknown): EventEnvelope => ({
  id: `e1-${sequence}`,
  workflowId: "wf",
  executionId: "e1",
  eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload,
});

const state = (status: string, sequence: number) =>
  ({
    executionId: "e1",
    workflowId: "wf",
    workflowVersion: "1.0.0",
    status,
    frames: {},
    variables: { _input: { ssn: "123-45-6789" } },
    sequence,
    startedAt: 0,
    updatedAt: 0,
  }) as unknown as ExecutionState;

describe.each(backends)(
  "eraseSubject in the destroy window with a sealed snapshot ($name)",
  (backend) => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const c of cleanups.splice(0)) await c();
    }, 60_000);

    async function world() {
      const w = await backend.make();
      cleanups.push(w.cleanup);
      const keys = new InMemoryKeyStore();
      // The app's wiring: a RAW event store, the SEALING snapshot store.
      const sealed = new EncryptingSnapshotStore(w.snapshots, keys, {
        sealState: true,
        subjectOf: () => SUBJECT,
      });
      await w.events.append(ev(0, "EXECUTION_STARTED", { input: { userId: SUBJECT } }));
      const index = SubjectIndex.fromEvents(await w.events.read("e1"), (e) =>
        e.eventType === "EXECUTION_STARTED"
          ? (e.payload as { input?: { userId?: string } }).input?.userId
          : undefined
      );
      // The first PAYLOAD_SHREDDED append fails: the key is destroyed, the tombstones are not written.
      let fail = true;
      const flaky = Object.assign(Object.create(w.events) as typeof w.events, {
        append: async (e: EventEnvelope) => {
          if (e.eventType === "PAYLOAD_SHREDDED" && fail) {
            fail = false;
            throw new Error("write conflict");
          }
          return w.events.append(e);
        },
      });
      const shred = (_s: string, executionIds: readonly string[]) =>
        shredSubject(keys, flaky, "e1", {
          subjectId: SUBJECT,
          executionIds: [...executionIds],
          snapshotStore: sealed,
        });
      const coordinator = (destroyed: (s: string) => boolean | Promise<boolean>) =>
        new EraseCoordinator({
          index,
          eventStore: w.events,
          shred,
          snapshotStore: sealed,
          destroyed,
        });
      const tombstones = async () =>
        (await w.events.read("e1")).filter((e) => e.eventType === "PAYLOAD_SHREDDED");
      return { w, keys, sealed, index, coordinator, tombstones };
    }

    it("a terminal execution: the retry completes, shreds once and purges the inbox stream", async () => {
      const { w, keys, sealed, coordinator, tombstones } = await world();
      await w.events.append(ev(1, "EXECUTION_COMPLETED", {}));
      await sealed.save({
        id: "s-1",
        executionId: "e1",
        workflowId: "wf",
        sequence: 1,
        state: state("completed", 1),
        createdAt: 0,
      });
      const inbox = `${INBOX_STREAM_PREFIX}e1`;
      await w.events.append({ ...ev(0, "MESSAGE_SENT", { n: 1 }), id: "m-0", executionId: inbox });
      const coord = coordinator((s) => keys.wasDestroyed(s));

      await expect(coord.eraseSubject(SUBJECT)).rejects.toBeInstanceOf(ShredIncompleteError);
      expect(await keys.get(SUBJECT)).toBeNull(); // the window: key gone ...
      expect(await tombstones()).toHaveLength(0); // ... no tombstone yet
      expect((await w.events.read(inbox)).length).toBeGreaterThan(0); // purge has not run

      const retry = await coord.eraseSubject(SUBJECT);
      expect(retry.outcome).toBe("erased");
      expect(retry.erased).toEqual(["e1"]);
      expect(await tombstones()).toHaveLength(1);
      expect(await w.events.read(inbox)).toEqual([]); // the inbox-stream purge ran
      expect(coord.pendingSubjects()).toEqual([]);
      // and a further retry (the snapshot now reads as shredded too) stays idempotent
      expect((await coord.eraseSubject(SUBJECT)).outcome).toBe("erased");
      expect(await tombstones()).toHaveLength(1);
    });

    it("a parked erasure resumed by handleEvent after the crash completes and unparks", async () => {
      const { w, keys, sealed, coordinator, tombstones } = await world();
      await sealed.save({
        id: "s-0",
        executionId: "e1",
        workflowId: "wf",
        sequence: 0,
        state: state("running", 0),
        createdAt: 0,
      });
      const coord = coordinator((s) => keys.wasDestroyed(s));
      expect((await coord.eraseSubject(SUBJECT)).outcome).toBe("parked");
      expect(coord.pendingSubjects()).toEqual([SUBJECT]);

      const done = ev(1, "EXECUTION_COMPLETED", {});
      await w.events.append(done);
      await expect(coord.handleEvent(done)).rejects.toBeInstanceOf(ShredIncompleteError);
      expect(await keys.get(SUBJECT)).toBeNull();
      expect(coord.pendingSubjects()).toEqual([SUBJECT]); // still parked: the shred did not finish

      await coord.handleEvent(done); // the resume
      expect(await tombstones()).toHaveLength(1);
      expect(coord.pendingSubjects()).toEqual([]); // parked.delete ran
      // the durable bookkeeping holds exactly the one request, never duplicated by the resume
      const pending = (await w.events.read("__loom_erasure__")).filter(
        (e) => e.eventType === "ERASURE_PENDING"
      );
      expect(pending).toHaveLength(1);
    });

    async function crashedWindow() {
      const c = await world();
      await c.w.events.append(ev(1, "EXECUTION_COMPLETED", {}));
      await c.sealed.save({
        id: "s-1",
        executionId: "e1",
        workflowId: "wf",
        sequence: 1,
        state: state("completed", 1),
        createdAt: 0,
      });
      await expect(
        c.coordinator((s) => c.keys.wasDestroyed(s)).eraseSubject(SUBJECT)
      ).rejects.toBeInstanceOf(ShredIncompleteError);
      return c;
    }

    it("the key destroyed but NOT proved destroyed still throws (an intent alone is not proof)", async () => {
      const { w, index, sealed, coordinator, tombstones } = await crashedWindow();
      const err = await coordinator(() => false)
        .eraseSubject(SUBJECT)
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(isKeyUnavailable(err)).toBe(true);
      expect(await tombstones()).toHaveLength(0);
      // and with no proof function configured at all
      const none = new EraseCoordinator({
        index,
        eventStore: w.events,
        shred: async () => {},
        snapshotStore: sealed,
      });
      await expect(none.eraseSubject(SUBJECT)).rejects.toSatisfy(isKeyUnavailable);
    });

    // A sibling of the world above that never ran an erasure: sealed checkpoint, key missing, NO intent.
    async function crashedWindowIndex() {
      const c = await world();
      await c.w.events.append(ev(1, "EXECUTION_COMPLETED", {}));
      await c.sealed.save({
        id: "s-1",
        executionId: "e1",
        workflowId: "wf",
        sequence: 1,
        state: state("completed", 1),
        createdAt: 0,
      });
      await c.keys.destroy(SUBJECT); // key lost, but no erase was ever recorded
      return { ...c, events: c.w.events };
    }

    it("an unavailable key with NO erase intent still throws, even when 'destroyed' is asserted", async () => {
      const c = await crashedWindowIndex();
      const coord = c.coordinator(() => true);
      const err = await coord.eraseSubject(SUBJECT).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(isKeyUnavailable(err)).toBe(true);
      expect(await c.tombstones()).toHaveLength(0);
      const intents = (await c.w.events.read("e1")).filter(
        (e) => e.eventType === "ERASURE_PENDING"
      );
      expect(intents).toHaveLength(0); // nothing was written
    });
  }
);
