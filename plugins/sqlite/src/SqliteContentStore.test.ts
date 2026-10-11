import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  ContentResolvingEventStore,
  encodeValue,
  sweepUnpinnedContent,
} from "@loom/plugin-content";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteContentStore } from "./SqliteContentStore";

// ContentStore SPI 1.3.0 (ADR 0055 D5/D6) on SQLite: touch time, migration, conditional delete.
describe("SqliteContentStore touch time (SPI 1.3.0)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  it("migrates a pre-1.3.0 file: adds touched_at and backfills existing blobs to NOW, once", async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-content-"));
    const path = join(dir, "content.db");
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE content_blobs (address TEXT PRIMARY KEY, bytes BLOB NOT NULL)");
    legacy
      .prepare("INSERT INTO content_blobs VALUES (?, ?)")
      .run("sha256:legacy", Buffer.from("x"));
    legacy.close();

    const first = new SqliteContentStore(path, { now: () => 5_000 });
    expect((await first.listPage({})).entries).toEqual([
      { address: "sha256:legacy", touchedAt: 5_000 }, // conservative: touched at migration
    ]);
    expect(await first.get({ __loomContent: "sha256:legacy" })).not.toBeNull();
    // The migration time protects it from a sweep whose cutoff precedes the migration.
    expect(await first.deleteIfUntouchedSince({ __loomContent: "sha256:legacy" }, 4_000)).toBe(
      false
    );
    await first.close();

    // Reopening does not re-backfill.
    const second = new SqliteContentStore(path, { now: () => 9_000 });
    expect((await second.listPage({})).entries[0]?.touchedAt).toBe(5_000);
    await second.close();
  });

  it("a re-put bumps touched_at (ON CONFLICT DO UPDATE, not INSERT OR IGNORE), never backwards", async () => {
    let clock = 1_000;
    const store = new SqliteContentStore(":memory:", { now: () => clock });
    const ref = await store.put(enc("same bytes"));
    clock = 2_000;
    await store.put(enc("same bytes"));
    expect((await store.listPage({})).entries).toEqual([
      { address: ref.__loomContent, touchedAt: 2_000 },
    ]);
    expect(await store.deleteIfUntouchedSince(ref, 1_500)).toBe(false);
    clock = 1_200; // a clock that steps back cannot make a re-cited blob look older
    await store.put(enc("same bytes"));
    expect((await store.listPage({})).entries[0]?.touchedAt).toBe(2_000);
    expect(await store.deleteIfUntouchedSince(ref, 2_001)).toBe(true);
    expect(await store.get(ref)).toBeNull();
    await store.close();
  });
});

// ContentStore SPI 1.4.0 (ADR 0055 D6 amendment 2) on SQLite: touch without a put.
describe("SqliteContentStore touch (SPI 1.4.0)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const open = (clock: { now: number }) => {
    dir = mkdtempSync(join(tmpdir(), "loom-content-"));
    return new SqliteContentStore(join(dir, "content.db"), { now: () => clock.now });
  };

  it("bumps existing blobs (max, never backwards), reports unknown addresses and inserts nothing", async () => {
    const clock = { now: 1_000 };
    const store = open(clock);
    const ref = await store.put(encodeValue("x"));
    const ghost = `sha256:${"b".repeat(64)}`;
    clock.now = 9_000;
    expect(await store.touch([ref.__loomContent, ghost, ref.__loomContent])).toEqual([ghost]);
    expect((await store.listPage({})).entries).toEqual([
      { address: ref.__loomContent, touchedAt: 9_000 },
    ]);
    clock.now = 2_000; // stepped back
    await store.touch([ref.__loomContent]);
    expect((await store.listPage({})).entries[0]?.touchedAt).toBe(9_000);
    expect(await store.touch([])).toEqual([]);
    await store.close();
  });

  it("touches a batch larger than one UPDATE chunk", async () => {
    const clock = { now: 1_000 };
    const store = open(clock);
    const addresses: string[] = [];
    for (let i = 0; i < 1_201; i++) addresses.push((await store.put(encodeValue(i))).__loomContent);
    clock.now = 5_000;
    expect(await store.touch(addresses)).toEqual([]);
    const page = await store.listPage({ limit: 5_000 });
    expect(page.entries.length).toBe(1_201);
    expect(page.entries.every((e) => e.touchedAt === 5_000)).toBe(true);
    await store.close();
  });

  it("prepares the touch UPDATE once per chunk size, not once per chunk per call", async () => {
    const clock = { now: 1_000 };
    const store = open(clock);
    const addresses: string[] = [];
    for (let i = 0; i < 1_100; i++) addresses.push((await store.put(encodeValue(i))).__loomContent);
    const db = (store as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const prepare = db.prepare.bind(db);
    const touchSql: string[] = [];
    db.prepare = (sql: string) => {
      if (sql.includes("SET touched_at")) touchSql.push(sql);
      return prepare(sql);
    };
    await store.touch(addresses); // 500 + 500 + 100
    await store.touch(addresses);
    await store.touch(addresses.slice(0, 500));
    expect(touchSql).toHaveLength(2); // sizes 500 and 100, each prepared once
    await store.close();
  });

  it("a fork made mid-sweep keeps the blob and replays (the ADR 0055 D6 race, on SQLite)", async () => {
    const OLD = 1_000;
    const NOW = 100_000;
    const clock = { now: OLD };
    const content = open(clock);
    const ref = await content.put(encodeValue("recalled memory"));
    clock.now = NOW;
    const raw = new InMemoryAsyncEventStore();
    const ev = (id: string, sequence: number, payload: unknown) => ({
      id: `${id}-${sequence}`,
      workflowId: "wf",
      executionId: id,
      eventType: sequence === 0 ? "EXECUTION_STARTED" : "STEP_COMPLETED",
      sequence,
      timestamp: OLD,
      payload,
    });
    await raw.append(ev("a-child", 0, { input: {} }));
    await raw.append(ev("a-child", 1, { output: 1 }));
    await raw.append(ev("p-parent", 0, { input: {} }));
    await raw.append(ev("p-parent", 1, { output: ref }));
    const resolving = new ContentResolvingEventStore(raw, content, { externalize: {} });
    const read = raw.read.bind(raw);
    const racing = Object.assign(Object.create(raw) as InMemoryAsyncEventStore, {
      read: async (id: string) => {
        const events = await read(id);
        if (id === "a-child") {
          await raw.deleteExecution("a-child");
          await resolving.copyPrefix!("p-parent", "a-child", 1, {});
          await raw.deleteExecution("p-parent");
        }
        return events;
      },
    });
    const result = await sweepUnpinnedContent({
      eventStores: [racing],
      snapshotStores: [{ loadLatest: async () => null, loadLatestBefore: async () => null }],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: 60_000, // the minimum guard margin an erasing orphan pass accepts
      now: NOW,
      reclaimOrphans: { completeScan: true, snapshotsTouchContent: true },
    });
    expect(result.orphansReclaimed).toEqual([]);
    expect(await content.get(ref)).not.toBeNull();
    const replayed = await resolving.read("a-child");
    expect(replayed[1]?.payload).toEqual({ output: "recalled memory" });
    // Control: the same blob, untouched and uncited, IS reclaimed (the guard is not a no-op).
    clock.now = NOW + 100_000;
    await raw.deleteExecution("a-child");
    const control = await sweepUnpinnedContent({
      eventStores: [raw],
      snapshotStores: [{ loadLatest: async () => null, loadLatestBefore: async () => null }],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: 60_000, // the minimum guard margin an erasing orphan pass accepts
      now: NOW + 100_000,
      reclaimOrphans: { completeScan: true, snapshotsTouchContent: true },
    });
    expect(control.orphansReclaimed).toEqual([ref.__loomContent]);
    await content.close();
  });
});
