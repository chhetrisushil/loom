import type { EventEnvelope } from "@loom/core";
import {
  ArchiveIncarnationError,
  type ArchiveStore,
  type EventStore,
  INBOX_TOPIC_SEQ_BASE,
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  TenantScopedArchiveStore,
  TenantScopedEventStore,
  inboxRegistryStreamId,
  inboxTopicStreamId,
  quarantineStreamId,
  reservedLateKey,
  segmentDigest,
} from "@loom/event-runtime";
import {
  EncryptingArchiveStore,
  EncryptingEventStore,
  InMemoryKeyStore,
  PayloadShreddedError,
} from "@loom/plugin-crypto";
import {
  PostgresArchiveStore,
  PostgresEventStore,
  migratePostgresStores,
  postgresPool,
} from "@loom/plugin-postgres";
import { SqliteArchiveStore, SqliteEventStore } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LogLifecycle } from "./LogLifecycle";
import { ReservedStreamArchive, reservedIncarnation } from "./archiveMove";
import {
  ArchiveIncompleteError,
  ArchiveTenantMismatchError,
  PlaintextArchiveError,
  ReservedStreamArchiveRequiredError,
  ReservedStreamDeleteUnsupportedError,
} from "./checkpointGuard";
import {
  INBOX_FLOOR_KIND,
  appendInboxMessage,
  deleteInbox,
  inboxStreamId,
  registerInboxTopic,
  trimInbox,
  trimTopicStream,
} from "./inbox";
import { appendQuarantineCopy, trimQuarantine } from "./quarantine";

// ADR 0139 (#728) - trimInbox, the topic-stream trim, the quarantine trim and the terminal delete of a
// chain's reserved streams MOVE the envelopes they remove into the archive first, and refuse without
// one. The evidence: archive u surviving stream == the original stream, byte-exact, on every backend;
// refusal changes nothing; a crash between archive and removal is a duplicate, never a gap; the
// erasure and tenant boundaries; stragglers; and a re-created stream never reuses an archived sequence.

interface Backend {
  name: string;
  skip?: boolean;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
  make(): { eventStore: EventStore; archive: ArchiveStore };
}

const pgUrl = process.env.LOOM_TEST_POSTGRES_URL;
const pgSchema = `loom_resarch_${process.pid}`;
const pgPool =
  pgUrl !== undefined
    ? postgresPool({ connectionString: pgUrl, options: `-c search_path=${pgSchema}` })
    : undefined;
const BACKENDS: Backend[] = [
  {
    name: "memory",
    make: () => ({
      eventStore: new InMemoryAsyncEventStore(),
      archive: new InMemoryArchiveStore(),
    }),
  },
  {
    name: "sqlite",
    make: () => ({
      eventStore: new SqliteEventStore(":memory:"),
      archive: new SqliteArchiveStore(":memory:"),
    }),
  },
  {
    name: "postgres",
    skip: pgUrl === undefined,
    setup: async () => {
      await pgPool?.query(`DROP SCHEMA IF EXISTS ${pgSchema} CASCADE`);
      await pgPool?.query(`CREATE SCHEMA ${pgSchema}`);
      if (pgPool !== undefined) await migratePostgresStores(pgPool);
    },
    make: () => ({
      eventStore: new PostgresEventStore(pgPool as never),
      archive: new PostgresArchiveStore(pgPool as never),
    }),
    teardown: async () => {
      await pgPool?.query(`DROP SCHEMA IF EXISTS ${pgSchema} CASCADE`);
      await pgPool?.end();
    },
  },
];

let seq = 0;
const chain = (tag: string): string => `${tag}-${process.pid}-${++seq}`;
const sender = { actor: "alice", tenant: "t1", onBehalfOf: "bob" };
const message = (topic: string, i: number) => ({
  topic,
  messageId: `m${i}`,
  payload: { i, note: `payload ${i}` },
  sender,
});
const now = () => 1_700_000_000_000;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const lifecycle = (eventStore: EventStore, archive: ArchiveStore): LogLifecycle =>
  new LogLifecycle(eventStore, new InMemoryAsyncSnapshotStore(), { compactionArchive: archive });

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip === true)(`reserved-stream archive on ${backend.name}`, () => {
    beforeAll(() => backend.setup?.());
    afterAll(() => backend.teardown?.());

    it("trimInbox: archive u surviving == the original stream, byte-exact, across two trims", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("legacy");
      const stream = inboxStreamId(c);
      for (let i = 0; i < 10; i++) await appendInboxMessage(eventStore, c, message("x", i), now);
      const original = clone(await eventStore.read(stream));
      expect(original).toHaveLength(10);
      const moved = new ReservedStreamArchive(archive, eventStore);

      expect(await trimInbox(eventStore, c, { x: 4 }, -1, moved)).toBe(4);
      expect((await eventStore.read(stream)).map((e) => e.sequence)).toEqual([0, 5, 6, 7, 8, 9]);
      expect(await trimInbox(eventStore, c, { x: 8 }, 4, moved)).toBe(8);
      expect((await eventStore.read(stream)).map((e) => e.sequence)).toEqual([0, 9]);

      const headers = await archive.headers(stream);
      expect(headers.map((h) => [h.from, h.through])).toEqual([
        [0, 4],
        [5, 8],
      ]);
      expect(headers.every((h) => h.incarnation === reservedIncarnation(stream))).toBe(true);
      const life = lifecycle(eventStore, archive);
      expect(clone((await life.readReservedWithArchive(stream)).events)).toEqual(original);
      expect((await life.reservedArchiveCoverage(stream)).unarchived).toEqual([]);
    });

    it("trimTopicStream: a topic stream's moved prefix is recoverable byte-exact", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("topic");
      const stream = inboxTopicStreamId(c, "hot");
      for (let i = 0; i < 6; i++) {
        await appendInboxMessage(eventStore, c, message("hot", i), now, true);
      }
      const original = clone(await eventStore.read(stream));
      const moved = new ReservedStreamArchive(archive, eventStore);
      const through = await trimTopicStream(
        eventStore,
        stream,
        INBOX_TOPIC_SEQ_BASE + 3,
        INBOX_TOPIC_SEQ_BASE - 1,
        moved
      );
      expect(through).toBe(INBOX_TOPIC_SEQ_BASE + 3);
      expect((await eventStore.read(stream)).map((e) => e.sequence)).toEqual([
        INBOX_TOPIC_SEQ_BASE + 4,
        INBOX_TOPIC_SEQ_BASE + 5,
      ]);
      const life = lifecycle(eventStore, archive);
      expect(clone((await life.readReservedWithArchive(stream)).events)).toEqual(original);
    });

    it("trimQuarantine: the freed copies are recoverable; only the anchor stays", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("quar");
      const stream = quarantineStreamId(c);
      for (let i = 0; i < 3; i++) {
        await appendInboxMessage(eventStore, c, message("a", i), now);
      }
      const inbox = await eventStore.read(inboxStreamId(c));
      for (const [i, original] of inbox.entries()) {
        await appendQuarantineCopy(eventStore, c, original, `k${i}`, "a", original.sequence);
      }
      const before = clone(await eventStore.read(stream));
      expect(before.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
      const moved = new ReservedStreamArchive(archive, eventStore);
      // every original is below the cursor and no live entry names a copy: all of it is disposed of
      const r = await trimQuarantine(eventStore, c, [], { a: 99 }, moved);
      expect(r).toEqual({ head: 3, oldestPinned: null });
      expect((await eventStore.read(stream)).map((e) => e.sequence)).toEqual([0]);
      const life = lifecycle(eventStore, archive);
      expect(clone((await life.readReservedWithArchive(stream)).events)).toEqual(before);

      // the next copy does NOT reuse an archived sequence: it lands above the archive's last
      const floor = moved.floorOf;
      const heldAt = await appendQuarantineCopy(
        eventStore,
        c,
        inbox[0] as EventEnvelope,
        "k-new",
        "a",
        77,
        floor
      );
      expect(heldAt).toBe(4);
    });

    it("refusal without an archive changes NOTHING (typed, names the fix)", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("refuse");
      const stream = inboxStreamId(c);
      for (let i = 0; i < 6; i++) await appendInboxMessage(eventStore, c, message("x", i), now);
      const before = clone(await eventStore.read(stream));
      const err = await trimInbox(eventStore, c, { x: 3 }, -1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReservedStreamArchiveRequiredError);
      expect(String(err)).toContain("inboxArchive");
      expect(clone(await eventStore.read(stream))).toEqual(before);
      // deleting the chain refuses too, and deletes none of its streams
      const del = await deleteInbox(eventStore, c).catch((e: unknown) => e);
      expect(del).toBeInstanceOf(ReservedStreamArchiveRequiredError);
      expect(clone(await eventStore.read(stream))).toEqual(before);
      expect(await archive.headers(stream)).toEqual([]);
    });

    it("a crash between the archive and the removal leaves a duplicate, never a gap, and the retry is clean", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("crash");
      const stream = inboxStreamId(c);
      for (let i = 0; i < 8; i++) await appendInboxMessage(eventStore, c, message("x", i), now);
      const original = clone(await eventStore.read(stream));
      const failing = Object.create(eventStore) as EventStore;
      let crash = true;
      const real = (id: string, through: number): Promise<void> =>
        (eventStore.truncatePrefixKeeping as NonNullable<EventStore["truncatePrefixKeeping"]>)(
          id,
          through,
          []
        );
      failing.truncatePrefixKeeping = async (id, through) => {
        if (crash) {
          crash = false;
          throw new Error("crash after the archive append");
        }
        return real(id, through);
      };
      const moved = new ReservedStreamArchive(archive, failing);
      await expect(trimInbox(failing, c, { x: 5 }, -1, moved)).rejects.toThrow(/crash after/);
      // archived AND still in the log: a duplicate
      expect((await archive.headers(stream)).map((h) => [h.from, h.through])).toEqual([[0, 5]]);
      expect((await eventStore.read(stream)).length).toBe(8);
      // the retry recognises the duplicate (byte-exact), appends nothing, and removes
      expect(await trimInbox(failing, c, { x: 5 }, -1, moved)).toBe(5);
      expect((await archive.headers(stream)).map((h) => [h.from, h.through])).toEqual([[0, 5]]);
      expect((await eventStore.read(stream)).map((e) => e.sequence)).toEqual([0, 6, 7]);
      expect(
        clone((await lifecycle(eventStore, archive).readReservedWithArchive(stream)).events)
      ).toEqual(original);
    });

    it("the terminal delete MOVES every stream of the chain; a re-created stream starts above the archive", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("retire");
      const topic = inboxTopicStreamId(c, "hot");
      const legacy = inboxStreamId(c);
      const registry = inboxRegistryStreamId(c);
      await registerInboxTopic(eventStore, c, "hot", 10, now);
      for (let i = 0; i < 3; i++) {
        await appendInboxMessage(eventStore, c, message("hot", i), now, true);
        await appendInboxMessage(eventStore, c, message("old", i), now);
      }
      const originals = {
        [topic]: clone(await eventStore.read(topic)),
        [legacy]: clone(await eventStore.read(legacy)),
        [registry]: clone(await eventStore.read(registry)),
      };
      const moved = new ReservedStreamArchive(archive, eventStore);
      await deleteInbox(eventStore, c, true, moved);
      for (const s of [topic, legacy, registry]) expect(await eventStore.read(s)).toEqual([]);
      const life = lifecycle(eventStore, archive);
      for (const [s, original] of Object.entries(originals)) {
        expect(clone((await life.readReservedWithArchive(s)).events)).toEqual(original);
      }
      // a send after the delete (the race) allocates ABOVE what the archive holds
      const again = await appendInboxMessage(
        eventStore,
        c,
        message("hot", 9),
        now,
        true,
        moved.floorOf
      );
      expect(again).toBe(INBOX_TOPIC_SEQ_BASE + 3);
      await deleteInbox(eventStore, c, true, moved); // the registry is gone: the prefix scan finds the stream
      expect((await archive.headers(topic)).map((h) => [h.from, h.through])).toEqual([
        [INBOX_TOPIC_SEQ_BASE, INBOX_TOPIC_SEQ_BASE + 2],
        [INBOX_TOPIC_SEQ_BASE + 3, INBOX_TOPIC_SEQ_BASE + 3],
      ]);
    });

    it("a straggler (a sequence the archive already holds, with other content) is archived in a late run, not dropped", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("late");
      await eventStore.append({
        id: `${c}-0`,
        workflowId: "w",
        executionId: c,
        eventType: "EXECUTION_STARTED",
        sequence: 0,
        timestamp: 1,
        payload: {},
      });
      const stream = inboxTopicStreamId(c, "y");
      await appendInboxMessage(eventStore, c, message("y", 0), now, true);
      const moved = new ReservedStreamArchive(archive, eventStore);
      await deleteInbox(eventStore, c, true, moved);
      // a send that allocated before the delete lands after it, at the SAME sequence
      const straggler: EventEnvelope = {
        id: `${stream}-${INBOX_TOPIC_SEQ_BASE}`,
        workflowId: "__loom_inbox__",
        executionId: stream,
        eventType: "INBOX_MESSAGE",
        sequence: INBOX_TOPIC_SEQ_BASE,
        timestamp: 5,
        payload: message("y", 99),
      };
      await eventStore.append(straggler);
      await deleteInbox(eventStore, c, true, moved);
      expect(await eventStore.read(stream)).toEqual([]);
      const late = await archive.read(reservedLateKey(stream, 1));
      expect(late).toHaveLength(1);
      expect(clone(late[0]?.envelopes)).toEqual([straggler]);
      // a crash-retry of the same straggler is an exact repeat: nothing new is written
      await eventStore.append(straggler);
      await deleteInbox(eventStore, c, true, moved);
      expect(await archive.headers(reservedLateKey(stream, 1))).toHaveLength(1);
      // the export-side reader returns it, tagged with its stream (for the chain's generation-0 execution)
      const read = await lifecycle(eventStore, archive).readReservedArchive(c);
      expect(read.map((r) => r.streamId).sort()).toEqual(
        [stream, reservedLateKey(stream, 1)].sort()
      );
    });

    it("the floor marker of a re-opened chain is seeded above the archive", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("floor");
      const legacy = inboxStreamId(c);
      for (let i = 0; i < 4; i++) await appendInboxMessage(eventStore, c, message("x", i), now);
      const moved = new ReservedStreamArchive(archive, eventStore);
      await deleteInbox(eventStore, c, false, moved); // unconsumed at the terminal: archived through 3
      const { seedInboxFloors } = await import("./inbox");
      await seedInboxFloors(eventStore, c, { x: 1 }, now, moved.floorOf);
      const [marker] = await eventStore.read(legacy);
      expect(marker?.eventType).toBe(INBOX_FLOOR_KIND);
      expect(marker?.sequence).toBe(4);
    });

    // ── the review of #729 ────────────────────────────────────────────────────────────────────────

    const ids = (events: readonly EventEnvelope[]): unknown[] =>
      events.map((e) => (e.payload as { messageId?: string }).messageId);
    const ownerStart = (c: string, timestamp = 1): EventEnvelope => ({
      id: `${c}-0`,
      workflowId: "w",
      executionId: c,
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp,
      payload: {},
    });

    it("B1: a message appended between the archive's read and the delete survives it, and the next delete archives it", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("race");
      const stream = inboxStreamId(c);
      for (let i = 0; i < 3; i++) await appendInboxMessage(eventStore, c, message("x", i), now);
      const moved = new ReservedStreamArchive(archive, eventStore);
      const store = eventStore as { deleteThrough?: EventStore["deleteThrough"] };
      const real = store.deleteThrough?.bind(eventStore) as NonNullable<
        EventStore["deleteThrough"]
      >;
      let injected = false;
      store.deleteThrough = async (id, through) => {
        if (!injected && id === stream) {
          injected = true; // the send lands after moveAll read the stream, before the delete
          await appendInboxMessage(eventStore, c, message("x", 99), now, false, moved.floorOf);
        }
        return real(id, through);
      };
      await deleteInbox(eventStore, c, false, moved);
      // not swept away: it is the live remainder of the stream
      expect(ids(await eventStore.read(stream))).toEqual(["m99"]);
      // the sender's re-check (retireInbox) / reclaimInbox runs the same bounded delete again
      await deleteInbox(eventStore, c, false, moved);
      expect(await eventStore.read(stream)).toEqual([]);
      const read = await lifecycle(eventStore, archive).readReservedWithArchive(stream);
      expect(ids(read.events)).toEqual(["m0", "m1", "m2", "m99"]);
    });

    it("B1: a store without deleteThrough REFUSES the delete and keeps the stream (never a whole-stream delete)", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("nodt");
      const stream = inboxStreamId(c);
      for (let i = 0; i < 2; i++) await appendInboxMessage(eventStore, c, message("x", i), now);
      let wholeDeletes = 0;
      const legacyStore = Object.create(eventStore, {
        deleteThrough: { value: undefined },
        deleteExecution: {
          value: async () => {
            wholeDeletes++;
          },
        },
      }) as EventStore;
      const moved = new ReservedStreamArchive(archive, legacyStore);
      await expect(deleteInbox(legacyStore, c, false, moved)).rejects.toThrow(
        ReservedStreamDeleteUnsupportedError
      );
      expect(wholeDeletes).toBe(0);
      expect(ids(await eventStore.read(stream))).toEqual(["m0", "m1"]);
    });

    it("B2: a stream trimmed BEFORE the archive existed reports the lost range, never reads as covered", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("legacy-gap");
      const stream = inboxStreamId(c);
      for (let i = 0; i < 10; i++) await appendInboxMessage(eventStore, c, message("x", i), now);
      await eventStore.truncatePrefix?.(stream, 5); // a pre-ADR trim: 1..5 gone, nothing archived
      const moved = new ReservedStreamArchive(archive, eventStore);
      await moved.moveThrough(stream, 7);
      await eventStore.truncatePrefix?.(stream, 7);
      // sequence 0 is its own segment; the next starts at ITS first envelope, never below it
      expect((await archive.headers(stream)).map((h) => [h.from, h.through])).toEqual([
        [0, 0],
        [6, 7],
      ]);
      const life = lifecycle(eventStore, archive);
      expect((await life.reservedArchiveCoverage(stream)).unarchived).toEqual([
        { from: 1, through: 5, why: "missing" },
      ]);
      await expect(life.readReservedWithArchive(stream)).rejects.toThrow(ArchiveIncompleteError);
      const partial = await life.readReservedWithArchive(stream, { allowIncomplete: true });
      expect(partial.events.map((e) => e.sequence)).toEqual([0, 6, 7, 8, 9]);
    });

    it("B2/M3: the same after the terminal delete (nothing live): the archive's own extent is judged", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("legacy-gap-del");
      const stream = inboxStreamId(c);
      await eventStore.append(ownerStart(c));
      for (let i = 0; i < 10; i++) await appendInboxMessage(eventStore, c, message("x", i), now);
      await eventStore.truncatePrefix?.(stream, 5);
      await deleteInbox(eventStore, c, false, new ReservedStreamArchive(archive, eventStore));
      expect(await eventStore.read(stream)).toEqual([]);
      const life = lifecycle(eventStore, archive);
      expect((await life.reservedArchiveCoverage(stream)).unarchived).toEqual([
        { from: 1, through: 5, why: "missing" },
      ]);
      await expect(life.readReservedWithArchive(stream)).rejects.toThrow(ArchiveIncompleteError);
      // the export reports the range instead of hiding it
      const exported = await life.readReservedArchive(c);
      expect(exported.find((r) => r.streamId === stream)?.unarchived).toEqual([
        { from: 1, through: 5, why: "missing" },
      ]);
    });

    it("B3: a re-created stream's sequence 0 is compared byte-exact; a different one is a straggler, not dropped", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("seq0");
      const stream = inboxStreamId(c);
      for (let i = 0; i < 3; i++) await appendInboxMessage(eventStore, c, message("x", i), now);
      const moved = new ReservedStreamArchive(archive, eventStore);
      await deleteInbox(eventStore, c, false, moved);
      // a node WITHOUT an archive floor re-creates the stream at its base
      await appendInboxMessage(eventStore, c, message("x", 42), now);
      expect((await eventStore.read(stream)).map((e) => e.sequence)).toEqual([0]);
      await deleteInbox(eventStore, c, false, moved);
      expect(await eventStore.read(stream)).toEqual([]);
      const read = await lifecycle(eventStore, archive).readReservedWithArchive(stream);
      expect(ids(read.events)).toEqual(["m0", "m1", "m2"]);
      expect(read.lateRuns.map((r) => ids(r.events))).toEqual([["m42"]]);
    });

    it("B3: a re-created quarantine anchor and copy are archived in a late run", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("qanchor");
      const stream = quarantineStreamId(c);
      await appendInboxMessage(eventStore, c, message("a", 0), now);
      const [first] = await eventStore.read(inboxStreamId(c));
      await appendQuarantineCopy(eventStore, c, first as EventEnvelope, "k0", "a", 0);
      const moved = new ReservedStreamArchive(archive, eventStore);
      await deleteInbox(eventStore, c, false, moved);
      await appendQuarantineCopy(eventStore, c, first as EventEnvelope, "k1", "a", 5); // no floor
      await deleteInbox(eventStore, c, false, moved);
      expect(await eventStore.read(stream)).toEqual([]);
      const read = await lifecycle(eventStore, archive).readReservedWithArchive(stream);
      const lateIds = read.lateRuns.flatMap((r) => r.events.map((e) => e.id));
      expect(lateIds.some((id) => id.includes("k1"))).toBe(true);
      expect(read.events.some((e) => e.id.includes("k0"))).toBe(true);
    });

    it("M2: the incarnation is the chain owner's bootstrap; a reused chain id refuses the previous run's segments", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("reuse");
      const stream = inboxStreamId(c);
      await eventStore.append(ownerStart(c, 1));
      for (let i = 0; i < 4; i++) await appendInboxMessage(eventStore, c, message("x", i), now);
      const moved = new ReservedStreamArchive(archive, eventStore);
      await deleteInbox(eventStore, c, false, moved);
      const [bootstrap] = await eventStore.read(c);
      expect((await archive.headers(stream))[0]?.incarnation).toBe(
        segmentDigest([bootstrap as EventEnvelope])
      );
      // retention deleted the execution (a retention archive kept the segments), then the id was reused
      await eventStore.deleteExecution?.(c);
      await eventStore.append(ownerStart(c, 2));
      await appendInboxMessage(eventStore, c, message("x", 50), now);
      await expect(moved.floorOf(stream)).rejects.toThrow(ArchiveIncarnationError);
      await expect(
        deleteInbox(eventStore, c, false, new ReservedStreamArchive(archive, eventStore))
      ).rejects.toThrow(ArchiveIncarnationError);
      const life = lifecycle(eventStore, archive);
      await expect(life.readReservedWithArchive(stream)).rejects.toThrow(ArchiveIncarnationError);
      await expect(life.readReservedArchive(c)).rejects.toThrow(ArchiveIncarnationError);
      expect(ids(await eventStore.read(stream))).toEqual(["m50"]); // nothing was removed
    });

    it("M3: late runs are returned (tagged, apart from the main run) and counted by the coverage", async () => {
      const { eventStore, archive } = backend.make();
      const c = chain("lateread");
      const stream = inboxStreamId(c);
      await eventStore.append(ownerStart(c));
      await appendInboxMessage(eventStore, c, message("x", 0), now);
      await appendInboxMessage(eventStore, c, message("x", 1), now);
      const moved = new ReservedStreamArchive(archive, eventStore);
      await deleteInbox(eventStore, c, false, moved);
      await eventStore.append({
        id: `${stream}-1`,
        workflowId: "__loom_inbox__",
        executionId: stream,
        eventType: "INBOX_MESSAGE",
        sequence: 1,
        timestamp: 9,
        payload: message("x", 77),
      });
      await deleteInbox(eventStore, c, false, moved);
      const life = lifecycle(eventStore, archive);
      const read = await life.readReservedWithArchive(stream);
      expect(ids(read.events)).toEqual(["m0", "m1"]);
      expect(read.lateRuns).toHaveLength(1);
      expect(read.lateRuns[0]?.key).toBe(reservedLateKey(stream, 1));
      expect(ids(read.lateRuns[0]?.events ?? [])).toEqual(["m77"]);
      const coverage = await life.reservedArchiveCoverage(stream);
      expect(coverage.unarchived).toEqual([]);
      expect(coverage.lateRuns.map((r) => r.key)).toEqual([reservedLateKey(stream, 1)]);
      // the export-side reader lists it (a late key is not a stream: no unarchived ranges of its own)
      const listed = await life.readReservedArchive(c);
      const late = listed.find((r) => r.streamId === reservedLateKey(stream, 1));
      expect(late?.unarchived).toEqual([]);
      expect(ids(late?.events ?? [])).toEqual(["m77"]);
    });
  });
}

describe("reserved-stream archive: the guards of compaction apply", () => {
  const SENSITIVE = { INBOX_MESSAGE: ["payload"] };

  it("an encrypting event store requires a SEALING archive on the same KeyStore (nothing is moved)", async () => {
    const keys = new InMemoryKeyStore();
    const inner = new InMemoryAsyncEventStore();
    const events = new EncryptingEventStore(inner, keys, { sensitive: SENSITIVE });
    const c = chain("enc");
    for (let i = 0; i < 5; i++) await appendInboxMessage(events, c, message("x", i), now);
    const before = clone(await inner.read(inboxStreamId(c)));
    const plain = new InMemoryArchiveStore();
    const err = await trimInbox(
      events,
      c,
      { x: 3 },
      -1,
      new ReservedStreamArchive(plain, events)
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaintextArchiveError);
    expect(clone(await inner.read(inboxStreamId(c)))).toEqual(before);
    expect(await plain.headers(inboxStreamId(c))).toEqual([]);

    // a sealing archive on ANOTHER KeyStore is refused too
    const foreign = new EncryptingArchiveStore(new InMemoryArchiveStore(), new InMemoryKeyStore());
    await expect(
      trimInbox(events, c, { x: 3 }, -1, new ReservedStreamArchive(foreign, events))
    ).rejects.toBeInstanceOf(PlaintextArchiveError);
  });

  it("a sealing archive keeps the moved envelopes at rest as ciphertext under the OWNER's subject, and a shred erases them", async () => {
    const keys = new InMemoryKeyStore();
    const inner = new InMemoryAsyncEventStore();
    const events = new EncryptingEventStore(inner, keys, { sensitive: SENSITIVE });
    const rawArchive = new InMemoryArchiveStore();
    const archive = new EncryptingArchiveStore(rawArchive, keys);
    const c = chain("sealed");
    const stream = inboxStreamId(c);
    const SECRET = "ssn-123-45-6789";
    for (let i = 0; i < 5; i++) {
      await appendInboxMessage(events, c, { ...message("x", i), payload: SECRET }, now);
    }
    const original = clone(await events.read(stream));
    expect(
      await trimInbox(events, c, { x: 3 }, -1, new ReservedStreamArchive(archive, events))
    ).toBe(3);
    expect(JSON.stringify(await rawArchive.read(stream))).not.toContain(SECRET);
    // the segment is sealed under the CHAIN OWNER's subject (the chain id), as the stream's payloads are
    expect(await keys.get(c)).not.toBeNull();
    expect(await keys.get(stream)).toBeNull();
    const life = new LogLifecycle(events, new InMemoryAsyncSnapshotStore(), {
      compactionArchive: archive,
    });
    expect(clone((await life.readReservedWithArchive(stream)).events)).toEqual(original);
    await keys.destroy(c);
    await expect(life.readReservedWithArchive(stream, { allowIncomplete: true })).rejects.toThrow(
      PayloadShreddedError
    );
  });

  it("B4(b): a message's SENDER is sealed under the SENDER's subject: erasing the sender shreds their identity in another chain's inbox AND archive; the owner's message stays", async () => {
    const keys = new InMemoryKeyStore();
    // the subject is an OPAQUE handle (it is stored in the clear beside the ciphertext)
    const senderSubjectOf = (s: { actor?: string }): string | undefined =>
      s.actor === "alice" ? "sbj-3c1f9a" : undefined;
    const events = new EncryptingEventStore(new InMemoryAsyncEventStore(), keys, {
      sensitive: SENSITIVE,
      senderSubjectOf,
    });
    const rawArchive = new InMemoryArchiveStore();
    const archive = new EncryptingArchiveStore(rawArchive, keys, { senderSubjectOf });
    const owner = chain("owner");
    const stream = inboxStreamId(owner);
    await events.append({
      id: `${owner}-0`,
      workflowId: "w",
      executionId: owner,
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: {},
    });
    const alice = { actor: "alice", tenant: "t1", onBehalfOf: "bob" };
    for (let i = 0; i < 4; i++) {
      await appendInboxMessage(
        events,
        owner,
        { ...message("x", i), sender: alice, payload: `body ${i}` },
        now
      );
    }
    // at rest, in the log, the identity is ciphertext (the owner's key never sealed it)
    const rest = JSON.stringify(
      await (events as unknown as { inner: EventStore }).inner.read(stream)
    );
    expect(rest).not.toContain("alice");
    expect(rest).not.toContain("bob");
    expect((await events.read(stream))[0]?.payload).toMatchObject({
      sender: alice,
      payload: "body 0",
    });

    // trim: the moved envelopes keep the sender sealed under THEIR subject inside the owner-sealed segment
    await trimInbox(events, owner, { x: 3 }, -1, new ReservedStreamArchive(archive, events));
    expect(JSON.stringify(await rawArchive.read(stream))).not.toContain("alice");
    const life = new LogLifecycle(events, new InMemoryAsyncSnapshotStore(), {
      compactionArchive: archive,
    });
    const before = await life.readReservedWithArchive(stream);
    expect(before.events.map((e) => (e.payload as { sender?: unknown }).sender)).toContainEqual(
      alice
    );

    // ERASE THE SENDER: only their key goes
    await keys.destroy("sbj-3c1f9a");
    const after = await life.readReservedWithArchive(stream);
    const live = await events.read(stream);
    for (const e of [...after.events, ...live]) {
      expect((e.payload as { sender: unknown }).sender).toEqual({ erased: true });
    }
    // the OWNER's message is intact (body readable), in the archive and in the live stream, and nothing threw
    expect(after.events.map((e) => (e.payload as { payload: unknown }).payload)).toEqual([
      "body 0",
      "body 1",
      "body 2",
      "body 3",
    ]);
    expect((live.at(-1)?.payload as { payload: unknown }).payload).toBe("body 3");
    // erasing the OWNER still erases the bodies (their key is untouched until then)
    await keys.destroy(owner);
    await expect(life.readReservedWithArchive(stream, { allowIncomplete: true })).rejects.toThrow(
      PayloadShreddedError
    );
  });

  it("the tenant guard applies: a scoped log needs an archive scoped to the same tenant", async () => {
    const inner = new InMemoryAsyncEventStore();
    const events = new TenantScopedEventStore(inner, "acme");
    const c = chain("tenant");
    for (let i = 0; i < 8; i++) await appendInboxMessage(events, c, message("x", i), now);
    const before = clone(await inner.read(`acme:${inboxStreamId(c)}`));
    const shared = new InMemoryArchiveStore();
    const err = await trimInbox(
      events,
      c,
      { x: 2 },
      -1,
      new ReservedStreamArchive(shared, events)
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveTenantMismatchError);
    expect(clone(await inner.read(`acme:${inboxStreamId(c)}`))).toEqual(before);
    expect(
      await trimInbox(
        events,
        c,
        { x: 2 },
        -1,
        new ReservedStreamArchive(new TenantScopedArchiveStore(shared, "acme"), events)
      )
    ).toBe(2);
    // the DECLARED tenant refuses a pairing scoped to another tenant
    await expect(
      trimInbox(
        events,
        c,
        { x: 5 },
        2,
        new ReservedStreamArchive(
          new TenantScopedArchiveStore(shared, "acme"),
          events,
          "someone-else"
        )
      )
    ).rejects.toBeInstanceOf(ArchiveTenantMismatchError);
  });
});
