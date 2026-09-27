import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
