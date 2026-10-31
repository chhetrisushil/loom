import type { EventEnvelope } from "@loom/core";
import {
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
  ArchiveTenantMismatchError,
  PlaintextArchiveError,
  ReservedStreamArchiveRequiredError,
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
      expect(clone(await life.readReservedWithArchive(stream))).toEqual(original);
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
      expect(clone(await life.readReservedWithArchive(stream))).toEqual(original);
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
      expect(clone(await life.readReservedWithArchive(stream))).toEqual(before);

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
      expect(clone(await lifecycle(eventStore, archive).readReservedWithArchive(stream))).toEqual(
        original
      );
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
        expect(clone(await life.readReservedWithArchive(s))).toEqual(original);
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
      const late = await archive.read(`${stream}#late-1`);
      expect(late).toHaveLength(1);
      expect(clone(late[0]?.envelopes)).toEqual([straggler]);
      // a crash-retry of the same straggler is an exact repeat: nothing new is written
      await eventStore.append(straggler);
      await deleteInbox(eventStore, c, true, moved);
      expect(await archive.headers(`${stream}#late-1`)).toHaveLength(1);
      // the export-side reader returns it, tagged with its stream (for the chain's generation-0 execution)
      await eventStore.append({
        id: `${c}-0`,
        workflowId: "w",
        executionId: c,
        eventType: "EXECUTION_STARTED",
        sequence: 0,
        timestamp: 1,
        payload: {},
      });
      const read = await lifecycle(eventStore, archive).readReservedArchive(c);
      expect(read.map((r) => r.streamId).sort()).toEqual([stream, `${stream}#late-1`].sort());
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
    expect(clone(await life.readReservedWithArchive(stream))).toEqual(original);
    await keys.destroy(c);
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
