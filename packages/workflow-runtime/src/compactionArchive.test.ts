import { canonicalJson, step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import {
  type ArchiveSegment,
  type ArchiveStore,
  type EventStore,
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  segmentDigest,
} from "@loom/event-runtime";
import {
  EncryptingArchiveStore,
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
  PayloadShreddedError,
  shredSubject,
} from "@loom/plugin-crypto";
import {
  PostgresArchiveStore,
  PostgresEventStore,
  PostgresSnapshotStore,
  migratePostgresStores,
  postgresPool,
} from "@loom/plugin-postgres";
import { SqliteArchiveStore, SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore, type SnapshotStore } from "@loom/snapshot-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import {
  ArchiveGapError,
  CompactionArchiveRequiredError,
  PlaintextArchiveError,
} from "./checkpointGuard";
import type { FlowRunner } from "./types";

// ADR 0138 — compaction MOVES the events it removes into an archive; it never deletes them.
// The evidence: archive ∪ surviving log == the original log, byte-exact, on every backend and
// across successive compactions; refusal without an archive; the crash order; erasure; and that
// nothing on the resume path ever reads the archive.

const io = z.object({ n: z.number() });
const s1 = step$({ id: "s1", name: "s1", toolId: "t1", inputSchema: io, outputSchema: io });
const s2 = step$({ id: "s2", name: "s2", toolId: "t2", inputSchema: io, outputSchema: io });
const s3 = step$({ id: "s3", name: "s3", toolId: "t3", inputSchema: io, outputSchema: io });
const FINDING = "FINDING_RECORDED";

const definition: FlowDefinition<{ n: number }, { n: number }> = {
  _tag: "FlowDefinition",
  id: "archive-flow",
  name: "archive-flow",
  version: "1.0.0",
  inputSchema: io,
  outputSchema: io,
  steps: [s1, s2, s3],
};

const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
  const a = await ctx.run(s1, input);
  ctx.emit(FINDING, { finding: "f1" });
  await ctx.suspend({ on: "go1" });
  const b = await ctx.run(s2, a);
  await ctx.suspend({ on: "go2" });
  const c = await ctx.run(s3, b);
  return { n: c.n };
};

interface Backend {
  name: string;
  skip?: boolean;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
  make(): {
    eventStore: EventStore;
    snapshotStore: SnapshotStore;
    archive: ArchiveStore;
  };
}

// One schema for the file: each case uses its own execution ids, and the schema is dropped after.
const pgUrl = process.env.LOOM_TEST_POSTGRES_URL;
const pgSchema = `loom_arch_${process.pid}`;
const pgPool =
  pgUrl !== undefined
    ? postgresPool({ connectionString: pgUrl, options: `-c search_path=${pgSchema}` })
    : undefined;
const postgres: Backend = {
  name: "postgres",
  skip: pgUrl === undefined,
  setup: async () => {
    await pgPool?.query(`DROP SCHEMA IF EXISTS ${pgSchema} CASCADE`);
    await pgPool?.query(`CREATE SCHEMA ${pgSchema}`);
    if (pgPool !== undefined) await migratePostgresStores(pgPool);
  },
  make: () => ({
    eventStore: new PostgresEventStore(pgPool as never),
    snapshotStore: new PostgresSnapshotStore(pgPool as never),
    archive: new PostgresArchiveStore(pgPool as never),
  }),
  teardown: async () => {
    await pgPool?.query(`DROP SCHEMA IF EXISTS ${pgSchema} CASCADE`);
    await pgPool?.end();
  },
};

const BACKENDS: Backend[] = [
  {
    name: "memory",
    make: () => ({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      archive: new InMemoryArchiveStore(),
    }),
  },
  {
    name: "sqlite",
    make: () => ({
      eventStore: new SqliteEventStore(":memory:"),
      snapshotStore: new SqliteSnapshotStore(":memory:"),
      archive: new SqliteArchiveStore(":memory:"),
    }),
  },
  postgres,
];

function boot(stores: {
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
}) {
  const effects = new EffectRuntime();
  for (const id of ["t1", "t2", "t3"] as const) {
    effects.register(id, new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
  }
  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    effectRuntime: effects,
    now: () => 1_000,
  });
  runtime.registerFlow(definition, runner);
  return runtime;
}

const gate = async (runtime: WorkflowRuntime, id: string, on: "go1" | "go2") => {
  const h = await runtime.resume(id, { eventType: on, payload: { answer: on } });
  return on === "go2" ? h.waitForCompletion() : h.waitForSuspend();
};

const bytes = (events: readonly EventEnvelope[]) => events.map((e) => canonicalJson(e));

describe.each(BACKENDS)("ADR 0138 compaction archive on $name", (backend) => {
  const { make } = backend;
  if (backend.skip === true) return void it.skip("needs LOOM_TEST_POSTGRES_URL", () => {});
  beforeAll(() => backend.setup?.());
  afterAll(() => backend.teardown?.());

  it("archive ∪ surviving log == the original log, byte-exact, across two compactions", async () => {
    const stores = make();
    const runtime = boot(stores);
    const life = new LogLifecycle(stores.eventStore, stores.snapshotStore, {
      compactionArchive: stores.archive,
    });
    const h = await runtime.start({ definition, runner }, { n: 1 }, { executionId: "e" });
    await h.waitForSuspend();
    const original1 = await stores.eventStore.read("e");

    const c1 = await life.compact("e");
    expect(c1).not.toBeNull();
    const live1 = await stores.eventStore.read("e");
    expect(live1.length).toBeLessThan(original1.length); // it really truncated
    const stitched1 = await life.readWithArchive("e");
    expect(bytes(stitched1)).toEqual(bytes(original1));
    // the archive holds exactly the removed events, no more
    const archived1 = await life.readArchived("e");
    expect(archived1.map((e) => e.sequence)).toEqual(
      original1.filter((e) => !live1.some((l) => l.sequence === e.sequence)).map((e) => e.sequence)
    );

    // resume, suspend again, compact a second time: only the NEW range is archived
    await gate(runtime, "e", "go1");
    const beforeSecond = await life.readWithArchive("e");
    expect(bytes(beforeSecond.slice(0, original1.length))).toEqual(bytes(original1));
    const c2 = await life.compact("e");
    expect(c2).not.toBeNull();
    expect(c2!).toBeGreaterThan(c1!);
    expect(bytes(await life.readWithArchive("e"))).toEqual(bytes(beforeSecond));
    const headers = await life.archiveHeaders("e");
    expect(headers.length).toBe(2);
    expect(headers[1]!.from).toBe(headers[0]!.through + 1); // contiguous, no gap
    expect(headers[1]!.through).toBe(c2);

    // finish: the whole history is still recoverable and the run completed correctly
    await gate(runtime, "e", "go2");
    const full = await life.readWithArchive("e");
    expect(bytes(full.slice(0, beforeSecond.length))).toEqual(bytes(beforeSecond));
    expect(full.map((e) => e.sequence)).toEqual(full.map((_, i) => i)); // gap-free 0..tip
    expect((await runtime.loadState("e"))!.status).toBe("completed");
  });

  it("recorded digests verify, and an altered archive is refused on read", async () => {
    const stores = make();
    const runtime = boot(stores);
    const life = new LogLifecycle(stores.eventStore, stores.snapshotStore, {
      compactionArchive: stores.archive,
    });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "d" })
    ).waitForSuspend();
    await life.compact("d");
    const [seg] = await stores.archive.read("d");
    expect(seg!.digest).toBe(segmentDigest(seg!.envelopes));
    expect(seg!.count).toBe(seg!.envelopes.length);

    // a tampering store that flips one payload on the way out
    const tampered: ArchiveStore = {
      append: (id, s) => stores.archive.append(id, s),
      headers: (id) => stores.archive.headers(id),
      read: async (id, r) =>
        (await stores.archive.read(id, r)).map(
          (s): ArchiveSegment => ({
            ...s,
            envelopes: s.envelopes.map((e, i) =>
              i === 1 ? { ...e, payload: { tampered: true } } : e
            ),
          })
        ),
      close: () => stores.archive.close(),
    };
    const audit = new LogLifecycle(stores.eventStore, stores.snapshotStore, {
      compactionArchive: tampered,
    });
    await expect(audit.readArchived("d")).rejects.toThrow(/does not match its recorded digest/);
  });
});

describe("ADR 0138 refusal and the crash order", () => {
  it("compaction REFUSES without an archive, and changes nothing", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const runtime = boot({ eventStore, snapshotStore });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "r" })
    ).waitForSuspend();
    const before = await eventStore.read("r");
    const snapBefore = await snapshotStore.loadLatest("r");
    const life = new LogLifecycle(eventStore, snapshotStore);
    await expect(life.compact("r")).rejects.toBeInstanceOf(CompactionArchiveRequiredError);
    await expect(life.compact("r")).rejects.toThrow(/storage\.archiveStore/); // names the fix
    expect(await eventStore.read("r")).toEqual(before);
    expect(await snapshotStore.loadLatest("r")).toEqual(snapBefore);
    expect(await life.readArchived("r")).toEqual([]);
  });

  it("a crash between archive and truncate leaves a duplicate, never a gap; re-compaction is idempotent", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const archive = new InMemoryArchiveStore();
    const runtime = boot({ eventStore, snapshotStore });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "x" })
    ).waitForSuspend();
    const original = await eventStore.read("x");

    // the store dies on truncate: archive has been written, the log has not shrunk
    const failing: EventStore = Object.create(eventStore, {
      truncatePrefix: {
        value: async () => {
          throw new Error("crash before truncate");
        },
      },
      truncatePrefixKeeping: { value: undefined },
    });
    const crashing = new LogLifecycle(failing, snapshotStore, { compactionArchive: archive });
    await expect(crashing.compact("x")).rejects.toThrow("crash before truncate");
    expect(await eventStore.read("x")).toEqual(original); // log untouched
    const afterCrash = await archive.headers("x");
    expect(afterCrash.length).toBe(1); // the duplicate: archived AND still in the log

    // the audit read tolerates the duplicate (one entry per sequence)
    const life = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: archive });
    expect(bytes(await life.readWithArchive("x"))).toEqual(bytes(original));

    // re-compaction: nothing re-appended, truncation completes, union still the original
    const through = await life.compact("x");
    expect(through).not.toBeNull();
    expect(await archive.headers("x")).toEqual(afterCrash);
    expect((await eventStore.read("x")).length).toBeLessThan(original.length);
    expect(bytes(await life.readWithArchive("x"))).toEqual(bytes(original));
  });

  it("a crash after the log grew archives only the new range on the retry", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const archive = new InMemoryArchiveStore();
    const runtime = boot({ eventStore, snapshotStore });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "g" })
    ).waitForSuspend();
    const failing: EventStore = Object.create(eventStore, {
      truncatePrefix: {
        value: async () => {
          throw new Error("crash");
        },
      },
      truncatePrefixKeeping: { value: undefined },
    });
    await expect(
      new LogLifecycle(failing, snapshotStore, { compactionArchive: archive }).compact("g")
    ).rejects.toThrow("crash");
    await gate(runtime, "g", "go1");
    const grown = await eventStore.read("g");
    const life = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: archive });
    expect(await life.compact("g")).not.toBeNull();
    const headers = await archive.headers("g");
    expect(headers.length).toBe(2);
    expect(headers[1]!.from).toBe(headers[0]!.through + 1);
    expect(bytes(await life.readWithArchive("g"))).toEqual(bytes(grown));
  });

  it("an event below the archive's last segment that the archive does not hold is refused (never lost)", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const archive = new InMemoryArchiveStore();
    const runtime = boot({ eventStore, snapshotStore });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "k" })
    ).waitForSuspend();
    // compact keeping the finding in place
    const keeping = new LogLifecycle(eventStore, snapshotStore, {
      compactionArchive: archive,
      pinnedEventTypes: [FINDING],
    });
    await gate(runtime, "k", "go1");
    expect(await keeping.compact("k")).not.toBeNull();
    await gate(runtime, "k", "go2");
    // the finding is in the log, below the archive's last segment, and NOT archived. Releasing the
    // pin would let a compaction remove it: refused.
    const releasing = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: archive });
    const before = await eventStore.read("k");
    await expect(releasing.compact("k")).rejects.toBeInstanceOf(ArchiveGapError);
    expect(await eventStore.read("k")).toEqual(before);
    // while the pin stays, compaction proceeds and the finding is still in the log
    expect(await keeping.compact("k")).not.toBeNull();
    expect((await eventStore.read("k")).some((e) => e.eventType === FINDING)).toBe(true);
  });

  it("compaction reads no archived body, and the runtime (which holds no archive) resumes a compacted execution", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const inner = new InMemoryArchiveStore();
    let bodyReads = 0;
    const counting: ArchiveStore = {
      append: (id, s) => inner.append(id, s),
      headers: (id) => inner.headers(id),
      read: (id, r) => {
        bodyReads++;
        return inner.read(id, r);
      },
      close: () => inner.close(),
    };
    const runtime = boot({ eventStore, snapshotStore });
    const life = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: counting });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "p" })
    ).waitForSuspend();
    expect(await life.compact("p")).not.toBeNull();
    expect(bodyReads).toBe(0); // the happy path appends and reads headers only
    await gate(runtime, "p", "go1");
    await gate(runtime, "p", "go2");
    expect((await runtime.loadState("p"))!.status).toBe("completed");
    const log = await eventStore.read("p");
    expect(log[1]!.sequence).toBeGreaterThan(1); // the prefix really is gone from the log
    expect(bodyReads).toBe(0); // resume and replay never touched the archive
    // the audit path is the only reader, and it recovers the prefix
    expect((await life.readArchived("p")).length).toBeGreaterThan(0);
    expect(bodyReads).toBe(1);
  });
});

describe("ADR 0138 erasure boundary", () => {
  function encrypted(archiveFor: (keys: InMemoryKeyStore) => ArchiveStore) {
    const keys = new InMemoryKeyStore();
    const rawEvents = new SqliteEventStore(":memory:");
    const rawSnaps = new SqliteSnapshotStore(":memory:");
    const eventStore = new EncryptingEventStore(rawEvents, keys, {
      sensitive: { EXECUTION_STARTED: ["input.n"] },
    });
    const snapshotStore = new EncryptingSnapshotStore(rawSnaps, keys, {
      sealState: true,
      events: rawEvents,
    });
    return { keys, rawEvents, rawSnaps, eventStore, snapshotStore, archive: archiveFor(keys) };
  }

  it("a plaintext archive over an encrypting event store is refused, and nothing moves", async () => {
    const app = encrypted(() => new InMemoryArchiveStore());
    const runtime = boot(app);
    await (
      await runtime.start({ definition, runner }, { n: 7 }, { executionId: "pl" })
    ).waitForSuspend();
    const before = await app.rawEvents.read("pl");
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      compactionArchive: app.archive,
    });
    await expect(life.compact("pl")).rejects.toBeInstanceOf(PlaintextArchiveError);
    expect(await app.rawEvents.read("pl")).toEqual(before);
    expect(await app.archive.headers("pl")).toEqual([]);
  });

  it("an archive sealed under ANOTHER KeyStore is refused", async () => {
    const app = encrypted(
      () => new EncryptingArchiveStore(new InMemoryArchiveStore(), new InMemoryKeyStore())
    );
    const runtime = boot(app);
    await (
      await runtime.start({ definition, runner }, { n: 7 }, { executionId: "ok" })
    ).waitForSuspend();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      compactionArchive: app.archive,
    });
    await expect(life.compact("ok")).rejects.toMatchObject({ reason: "keys-not-shared" });
  });

  it("under the SAME KeyStore the archive is ciphertext at rest, readable, and a shred makes it unreadable", async () => {
    let inner!: InMemoryArchiveStore;
    const app = encrypted((keys) => {
      inner = new InMemoryArchiveStore();
      return new EncryptingArchiveStore(inner, keys);
    });
    const runtime = boot(app);
    await (
      await runtime.start({ definition, runner }, { n: 918273645 }, { executionId: "sh" })
    ).waitForSuspend();
    const original = await app.eventStore.read("sh");
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      compactionArchive: app.archive,
    });
    expect(await life.compact("sh")).not.toBeNull();

    // at rest: no plaintext anywhere in the stored segment
    const stored = await inner.read("sh");
    expect(JSON.stringify(stored)).not.toContain("918273645");
    expect(JSON.stringify(stored)).not.toContain("STEP_STARTED");
    // readable with the key, and the union is still the original
    expect(bytes(await life.readWithArchive("sh"))).toEqual(bytes(original));

    await shredSubject(app.keys, app.rawEvents, "sh", { snapshotStore: app.rawSnaps });
    await expect(life.readArchived("sh")).rejects.toBeInstanceOf(PayloadShreddedError);
  });
});
