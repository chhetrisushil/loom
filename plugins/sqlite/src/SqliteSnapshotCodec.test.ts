import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnapshotStoreConformance } from "@loom/conformance";
import type { ExecutionState } from "@loom/core";
import { type Snapshot, zstdAvailable } from "@loom/snapshot-runtime";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSnapshotStore } from "./SqliteSnapshotStore";
import { sqliteStorage } from "./preset";

// ADR 0140 - the zstd snapshot codec on SQLite. Skipped on a Node without zlib.zstd (needs >= 22.15).
const zstd = describe.skipIf(!zstdAvailable());

function snap(id: string, sequence: number, state: unknown): Snapshot {
  return {
    id,
    executionId: "x",
    workflowId: "wf",
    sequence,
    state: state as ExecutionState,
    createdAt: sequence,
  };
}

const words = "the customer ticket refund order invoice payment failed retry approval".split(" ");
const bigState = (tag: string): unknown => ({
  tag,
  steps: Object.fromEntries(
    Array.from({ length: 600 }, (_, i) => [
      `s${i}`,
      {
        text: Array.from({ length: 30 }, (_, j) => words[(i + j * 3) % words.length]).join(" "),
        i,
      },
    ])
  ),
});

const adversarial: Record<string, unknown> = {
  proto: JSON.parse('{"__proto__":{"polluted":true},"a":1}'),
  surrogates: { hi: "a\ud800b", lo: "c\udc00d", nul: "x\u0000y" },
  keyOrder: { z: 1, a: 2, 10: "ten", 2: "two" },
  deep: (() => {
    let d: unknown = { leaf: 1 };
    for (let i = 0; i < 300; i++) d = { n: d };
    return d;
  })(),
};

describe("SqliteSnapshotStore default (codec off) is byte-identical to before", () => {
  it("stores the JSON text in a TEXT-class value, and has no snapshotCodec", async () => {
    const store = new SqliteSnapshotStore(":memory:");
    expect(store.snapshotCodec).toBe("none");
    const db = (store as unknown as { db: Database.Database }).db;
    await store.save(snap("a", 1, bigState("a")));
    const row = db.prepare("SELECT typeof(state) AS t, state FROM snapshots").get() as {
      t: string;
      state: string;
    };
    expect(row.t).toBe("text");
    expect(row.state).toBe(JSON.stringify(bigState("a")));
    await store.close();
  });
});

zstd("SqliteSnapshotStore codec: zstd (ADR 0140)", () => {
  runSnapshotStoreConformance(
    () => new SqliteSnapshotStore(":memory:", { codec: "zstd" }),
    "SqliteSnapshotStore (zstd)"
  );

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-sqlite-codec-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a BLOB frame, much smaller than the JSON text", async () => {
    const path = join(dir, "s.db");
    const store = new SqliteSnapshotStore(path, { codec: "zstd" });
    await store.save(snap("a", 1, bigState("a")));
    await store.close();
    const db = new Database(path, { readonly: true });
    const row = db
      .prepare("SELECT typeof(state) AS t, length(state) AS n FROM snapshots")
      .get() as {
      t: string;
      n: number;
    };
    db.close();
    expect(row.t).toBe("blob");
    expect(row.n).toBeLessThan(JSON.stringify(bigState("a")).length / 5);
  });

  for (const [name, state] of Object.entries(adversarial)) {
    it(`round-trips ${name} byte-identically as JSON`, async () => {
      const store = new SqliteSnapshotStore(":memory:", { codec: "zstd" });
      await store.save(snap("a", 1, state));
      const back = (await store.loadLatest("x"))?.state;
      assert.deepStrictEqual(back, state);
      expect(JSON.stringify(back)).toBe(JSON.stringify(state));
      await store.close();
    });
  }

  it("reads a MIXED file: old TEXT rows and new BLOB rows, through every read path", async () => {
    const path = join(dir, "mixed.db");
    const old = new SqliteSnapshotStore(path); // a pre-codec deployment
    await old.save(snap("a", 1, bigState("old-1")));
    await old.save(snap("b", 5, bigState("old-5")));
    await old.close();

    const next = new SqliteSnapshotStore(path, { codec: "zstd" }); // opted in later
    await next.save(snap("c", 9, bigState("new-9")));
    expect((await next.loadAt("x", 1))?.state).toEqual(bigState("old-1"));
    expect((await next.loadLatestBefore("x", 8))?.state).toEqual(bigState("old-5"));
    expect((await next.loadLatest("x"))?.state).toEqual(bigState("new-9"));
    await next.close();

    // ...and an opt-OUT later still reads the frames, because reads dispatch on the stored format.
    const off = new SqliteSnapshotStore(path);
    expect((await off.loadLatest("x"))?.state).toEqual(bigState("new-9"));
    expect((await off.loadAt("x", 5))?.state).toEqual(bigState("old-5"));
    await off.close();
  });

  it("a re-save by id replaces a TEXT row with a frame, and prune still deletes by range", async () => {
    const path = join(dir, "r.db");
    const old = new SqliteSnapshotStore(path);
    await old.save(snap("a", 1, { v: "text" }));
    await old.close();
    const s = new SqliteSnapshotStore(path, { codec: "zstd" });
    await s.save(snap("a", 1, { v: "frame" }));
    expect((await s.loadAt("x", 1))?.state).toEqual({ v: "frame" });
    await s.save(snap("b", 4, bigState("b")));
    expect(await s.pruneSnapshots("x", { after: 0, before: 4 })).toBe(1);
    expect(await s.loadAt("x", 1)).toBeNull();
    await s.close();
  });

  it("a corrupted frame fails loudly instead of decoding to a wrong state", async () => {
    const path = join(dir, "c.db");
    const s = new SqliteSnapshotStore(path, { codec: "zstd" });
    await s.save(snap("a", 1, bigState("a")));
    await s.close();
    const db = new Database(path);
    db.prepare("UPDATE snapshots SET state = X'02DEADBEEF'").run();
    db.close();
    const again = new SqliteSnapshotStore(path);
    await expect(again.loadLatest("x")).rejects.toThrow(/does not decode/);
    await again.close();
  });

  it("sqliteStorage({ snapshotCodec }) hands the codec to the snapshot store", async () => {
    const storage = sqliteStorage({ dir, snapshotCodec: "zstd" });
    expect((storage.snapshotStore as unknown as SqliteSnapshotStore).snapshotCodec).toBe("zstd");
    await storage.snapshotStore?.close();
    await storage.eventStore.close();
  });

  it("refuses an unknown codec name", () => {
    expect(() => new SqliteSnapshotStore(":memory:", { codec: "gzip" as never })).toThrow(
      TypeError
    );
  });
});
