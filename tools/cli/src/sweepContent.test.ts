import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSegment } from "@loom/event-runtime";
import {
  SqliteArchiveStore,
  SqliteContentStore,
  SqliteEventStore,
  SqliteSnapshotStore,
} from "@loom/plugin-sqlite";
import { ReplayVM } from "@loom/replay-vm";
import { afterEach, describe, expect, it } from "vitest";
import { requireExistingFile } from "./stores";
import { cmdSweepContent } from "./sweepContent";

const DAY = 24 * 3_600_000;

describe("loom sweep content (DX-2, K10.6)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function seed() {
    dir = mkdtempSync(join(tmpdir(), "loom-sweep-"));
    const db = join(dir, "events.db");
    const contentDb = join(dir, "content.db");
    const events = new SqliteEventStore(db);
    const old = Date.now() - 90 * DAY;
    // SPI 1.3.0 stamps a touch time on put: the blobs were put when they were cited.
    const content = new SqliteContentStore(contentDb, { now: () => old });
    const enc = (s: string) => new TextEncoder().encode(s);

    const evidence = await content.put(enc("EXPLAIN plan"));
    const telemetry = await content.put(enc("pg_stat sample"));
    await events.append({
      id: "w1-0",
      workflowId: "wf",
      executionId: "wake-1",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      timestamp: old,
      payload: {
        stepId: "read",
        output: {
          __loomClaimCheck: true,
          ref: { __loomContent: telemetry.__loomContent },
          size: 1,
        },
      },
    });
    await events.append({
      id: "w1-1",
      workflowId: "wf",
      executionId: "wake-1",
      eventType: "FINDING_RECORDED",
      sequence: 1,
      timestamp: old,
      payload: { evidence: [{ __loomContent: evidence.__loomContent }] },
    });
    await events.close();
    await content.close();
    return { db, contentDb, evidence, telemetry };
  }

  it("dry-run reports would-reclaim without deleting; --apply erases unpinned only", async () => {
    const { db, contentDb, evidence, telemetry } = await seed();

    const dry = await cmdSweepContent({
      db,
      content: contentDb,
      pin: "FINDING_RECORDED",
      ttlMs: 30 * DAY,
      apply: false,
    });
    expect(dry).toContain("DRY RUN");
    // The finding's evidence is a BARE ref: load-bearing as well as pinned (ADR 0055 D4).
    expect(dry).toContain("load-bearing: 1");
    expect(dry).toContain("would-reclaim (1)");
    expect(dry).toContain("race-safe: yes"); // SQLite has the conditional delete (ADR 0055 D5)
    expect(dry).toContain(telemetry.__loomContent);
    // Nothing deleted yet.
    const check = new SqliteContentStore(contentDb);
    expect(await check.get(telemetry)).not.toBeNull();
    await check.close();

    const applied = await cmdSweepContent({
      db,
      content: contentDb,
      pin: "FINDING_RECORDED",
      ttlMs: 30 * DAY,
      apply: true,
    });
    expect(applied).toContain("reclaimed (1)");
    const after = new SqliteContentStore(contentDb);
    expect(await after.get(telemetry)).toBeNull(); // disposable telemetry gone
    expect(await after.get(evidence)).not.toBeNull(); // pinned evidence survives
    await after.close();
  });

  it("never reclaims a stale BARE ref, and says why (ADR 0055 D4)", async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-sweep-"));
    const db = join(dir, "events.db");
    const contentDb = join(dir, "content.db");
    const events = new SqliteEventStore(db);
    const content = new SqliteContentStore(contentDb, { now: () => Date.now() - 60 * DAY });
    // What ContentResolvingEventStore leaves in the raw log for an externalized field.
    const externalized = await content.put(new TextEncoder().encode('{"rows":[1,2,3]}'));
    await events.append({
      id: "p-0",
      workflowId: "wf",
      executionId: "perpetual",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      timestamp: Date.now() - 60 * DAY,
      payload: { stepId: "read", output: { ...externalized, codec: "json" } },
    });
    await events.close();
    await content.close();

    const applied = await cmdSweepContent({
      db,
      content: contentDb,
      pin: "FINDING_RECORDED",
      ttlMs: 30 * DAY,
      apply: true,
    });
    expect(applied).toContain("load-bearing: 1");
    expect(applied).toContain("reclaimed (0)");
    const after = new SqliteContentStore(contentDb);
    expect(await after.get(externalized)).not.toBeNull();
    await after.close();
  });

  /** An events.db, a snap.db and a content.db holding one blob put 60 days ago that nothing cites. */
  async function orphanSeed() {
    dir = mkdtempSync(join(tmpdir(), "loom-sweep-"));
    const db = join(dir, "events.db");
    const snap = join(dir, "snap.db");
    const contentDb = join(dir, "content.db");
    const events = new SqliteEventStore(db);
    await events.close();
    await new SqliteSnapshotStore(snap).close();
    const old = Date.now() - 60 * DAY;
    const content = new SqliteContentStore(contentDb, { now: () => old });
    // Put, then the process died before the append: nothing in the log cites it.
    const orphan = await content.put(new TextEncoder().encode("crashed before append"));
    await content.close();
    return { db, snap, contentDb, orphan };
  }

  async function stillThere(contentDb: string, ref: { __loomContent: string }) {
    const check = new SqliteContentStore(contentDb);
    const bytes = await check.get(ref);
    await check.close();
    return bytes !== null;
  }

  it("--orphans reclaims a blob nothing cites once untouched for the TTL (ADR 0055 D6)", async () => {
    const { db, snap, contentDb, orphan } = await orphanSeed();

    const without = await cmdSweepContent({
      db,
      snap,
      content: contentDb,
      ttlMs: 30 * DAY,
      apply: true,
    });
    expect(without).not.toContain("orphans");
    expect(await stillThere(contentDb, orphan)).toBe(true);

    const dry = await cmdSweepContent({
      db,
      snap,
      content: contentDb,
      ttlMs: 30 * DAY,
      apply: false,
      orphans: true,
    });
    expect(dry).toContain("would-reclaim orphans (1)");
    expect(dry).toContain(orphan.__loomContent);
    expect(dry).toMatch(/no --archive-db/); // the hazard the sweep cannot detect, said loudly

    const applied = await cmdSweepContent({
      db,
      snap,
      content: contentDb,
      ttlMs: 30 * DAY,
      apply: true,
      orphans: true,
      noArchive: true,
      snapshotsTouchContent: true,
    });
    expect(applied).toContain("reclaimed orphans (1)");
    expect(await stillThere(contentDb, orphan)).toBe(false);
  });

  it("refuses --orphans --apply with a TTL below the guard margin (--ttl 0 included); the dry run still reports", async () => {
    const { db, snap, contentDb, orphan } = await orphanSeed();
    for (const ttlMs of [0, 59_999]) {
      await expect(
        cmdSweepContent({
          db,
          snap,
          content: contentDb,
          ttlMs,
          apply: true,
          orphans: true,
          noArchive: true,
          snapshotsTouchContent: true,
        })
      ).rejects.toThrow(/guard margin of at least 60000ms/);
    }
    expect(await stillThere(contentDb, orphan)).toBe(true);
    const dry = await cmdSweepContent({
      db,
      snap,
      content: contentDb,
      ttlMs: 0,
      apply: false,
      orphans: true,
    });
    expect(dry).toContain("would-reclaim orphans");
  });

  it("refuses --orphans --apply without --snapshots-touch-content, erasing nothing; the dry run and the asserted run work", async () => {
    const { db, snap, contentDb, orphan } = await orphanSeed();
    const opts = {
      db,
      snap,
      content: contentDb,
      ttlMs: 30 * DAY,
      orphans: true,
      noArchive: true,
    };
    await expect(cmdSweepContent({ ...opts, apply: true })).rejects.toThrow(
      /--snapshots-touch-content.*ContentTouchingSnapshotStore/s
    );
    expect(await stillThere(contentDb, orphan)).toBe(true);
    const dry = await cmdSweepContent({ ...opts, apply: false });
    expect(dry).toContain("would-reclaim orphans (1)");
    const applied = await cmdSweepContent({ ...opts, apply: true, snapshotsTouchContent: true });
    expect(applied).toContain("reclaimed orphans (1)");
    expect(await stillThere(contentDb, orphan)).toBe(false);
  });

  it("refuses --orphans --apply with no archive unless --no-archive says there is none", async () => {
    const { db, snap, contentDb, orphan } = await orphanSeed();
    await expect(
      cmdSweepContent({ db, snap, content: contentDb, ttlMs: 30 * DAY, apply: true, orphans: true })
    ).rejects.toThrow(/--no-archive/);
    expect(await stillThere(contentDb, orphan)).toBe(true);
  });

  it("warns BEFORE erasing when --no-archive is given", async () => {
    const { db, snap, contentDb } = await orphanSeed();
    const order: string[] = [];
    const warn = console.error;
    console.error = (m: string) => order.push(`warn:${m}`);
    try {
      const out = await cmdSweepContent({
        db,
        snap,
        content: contentDb,
        ttlMs: 30 * DAY,
        apply: true,
        orphans: true,
        noArchive: true,
        snapshotsTouchContent: true,
      });
      order.push("report");
      expect(out).toContain("reclaimed orphans (1)");
    } finally {
      console.error = warn;
    }
    expect(order[0]).toMatch(/^warn:.*archive/);
    expect(order.at(-1)).toBe("report");
  });

  it("refuses --orphans on the --db path without --snap: a compacted prefix lives in its snapshot", async () => {
    const { db, contentDb, orphan } = await orphanSeed();
    await expect(
      cmdSweepContent({
        db,
        content: contentDb,
        ttlMs: 30 * DAY,
        apply: true,
        orphans: true,
        noArchive: true,
        snapshotsTouchContent: true,
      })
    ).rejects.toThrow(/--snap/);
    expect(await stillThere(contentDb, orphan)).toBe(true);
  });

  it("refuses --orphans with --archive-db but no --archive-snap: an archived run's checkpoint lives there", async () => {
    const { db, snap, contentDb, orphan } = await orphanSeed();
    const archiveDb = join(dir, "archive.db");
    await new SqliteEventStore(archiveDb).close();
    await expect(
      cmdSweepContent({
        db,
        snap,
        content: contentDb,
        archiveDb,
        ttlMs: 30 * DAY,
        apply: true,
        orphans: true,
      })
    ).rejects.toThrow(/--archive-snap/);
    expect(await stillThere(contentDb, orphan)).toBe(true);
  });

  it("the built binary EXITS NON-ZERO on a refusal, so a script can tell", async () => {
    const cli = join(__dirname, "..", "dist", "cli.js");
    if (!existsSync(cli)) {
      execFileSync("npx", ["tsc", "--build", join(__dirname, "..", "tsconfig.json")]);
    }
    const { db, snap, contentDb, orphan } = await orphanSeed();
    const refused = spawnSync(
      process.execPath,
      [
        cli,
        "sweep",
        "content",
        "--db",
        db,
        "--snap",
        snap,
        "--content",
        contentDb,
        "--orphans",
        "--apply",
      ],
      { encoding: "utf8" }
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/--no-archive/);
    expect(await stillThere(contentDb, orphan)).toBe(true);

    const ok = spawnSync(
      process.execPath,
      [cli, "sweep", "content", "--db", db, "--snap", snap, "--content", contentDb, "--orphans"],
      { encoding: "utf8" }
    );
    expect(ok.status).toBe(0); // a dry run is not a refusal
  });

  it("a typo'd --archive-db / --archive-snap / --content is refused before anything opens, creates no file, erases nothing", async () => {
    const { db, snap, contentDb, orphan } = await orphanSeed();
    const base = {
      db,
      snap,
      content: contentDb,
      orphans: true,
      apply: true,
      snapshotsTouchContent: true,
      ttlMs: 30 * DAY,
    };
    const typoArchive = join(dir, "archive-typo.db");
    const typoArchiveSnap = join(dir, "archive-snap-typo.db");
    const typoContent = join(dir, "content-typo.db");
    await expect(
      cmdSweepContent({ ...base, archiveDb: typoArchive, archiveSnap: typoArchiveSnap })
    ).rejects.toThrow(/--archive-db: no such file/);
    await expect(cmdSweepContent({ ...base, archiveSnap: typoArchiveSnap })).rejects.toThrow(
      /--archive-snap: no such file/
    );
    await expect(cmdSweepContent({ ...base, content: typoContent })).rejects.toThrow(
      /--content: no such file/
    );
    for (const f of [typoArchive, typoArchiveSnap, typoContent]) expect(existsSync(f)).toBe(false);
    expect(await stillThere(contentDb, orphan)).toBe(true);
  });

  it("the built binary exits 1 for a typo'd --archive-db and leaves the blob alone", async () => {
    const { db, snap, contentDb, orphan } = await orphanSeed();
    const cli = join(__dirname, "..", "dist", "cli.js");
    const typo = join(dir, "nope.db");
    const r = spawnSync(
      process.execPath,
      [
        cli,
        "sweep",
        "content",
        "--db",
        db,
        "--snap",
        snap,
        "--content",
        contentDb,
        "--archive-db",
        typo,
        "--archive-snap",
        snap,
        "--orphans",
        "--apply",
        "--snapshots-touch-content",
      ],
      { encoding: "utf8" }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(typo);
    expect(existsSync(typo)).toBe(false);
    expect(await stillThere(contentDb, orphan)).toBe(true);
  });

  it("a zero-byte or non-SQLite file is refused, not migrated into a database", async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-sweep-"));
    const empty = join(dir, "empty.db");
    const junk = join(dir, "junk.db");
    writeFileSync(empty, "");
    writeFileSync(junk, "this is not a database at all");
    for (const f of [empty, junk]) {
      expect(() => requireExistingFile("db", f)).toThrow(/not a SQLite database/);
    }
    expect(statSync(empty).size).toBe(0);
    expect(readFileSync(junk, "utf8")).toBe("this is not a database at all");
  });
});

// ADR 0138 B1 - an erasing --orphans pass over a COMPACTED log needs the compaction archive: the events
// compaction moved are cited only there, so without it their blobs are orphans to the sweep.
describe("loom sweep content --orphans over a compacted log (ADR 0138)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function compactedSeed(opts: { withArchive: boolean }) {
    dir = mkdtempSync(join(tmpdir(), "loom-sweep-arch-"));
    const db = join(dir, "events.db");
    const snap = join(dir, "snap.db");
    const contentDb = join(dir, "content.db");
    const old = Date.now() - 60 * DAY;
    const content = new SqliteContentStore(contentDb, { now: () => old });
    const note = await content.put(new TextEncoder().encode("only the removed event cited this"));
    await content.close();
    const ev = (sequence: number, eventType: string, payload: unknown) => ({
      id: `c-${sequence}`,
      workflowId: "wf",
      executionId: "c",
      eventType,
      sequence,
      timestamp: old,
      payload,
    });
    const events = [
      ev(0, "EXECUTION_STARTED", { input: {} }),
      ev(1, "NOTE_RECORDED", { sample: { __loomClaimCheck: true, ref: note, size: 1 } }),
      ev(2, "STEP_STARTED", { stepId: "s" }),
    ];
    const store = new SqliteEventStore(db);
    for (const e of events) await store.append(e);
    await store.truncatePrefix("c", 2);
    await store.close();
    const snaps = new SqliteSnapshotStore(snap);
    await snaps.save({
      id: "cp",
      executionId: "c",
      workflowId: "wf",
      sequence: 2,
      state: new ReplayVM(events).getState(),
      createdAt: 0,
    });
    await snaps.close();
    if (opts.withArchive) {
      const archive = new SqliteArchiveStore(join(dir, "archive.db"));
      await archive.append("c", buildSegment(events.slice(1), "inc", 1, 2));
      await archive.close();
    }
    return { db, snap, contentDb, note };
  }

  const base = (s: { db: string; snap: string; contentDb: string }) => ({
    db: s.db,
    snap: s.snap,
    content: s.contentDb,
    ttlMs: 30 * DAY,
    apply: true,
    orphans: true,
    noArchive: true,
    snapshotsTouchContent: true,
  });
  const alive = async (contentDb: string, ref: { __loomContent: string }) => {
    const c = new SqliteContentStore(contentDb);
    const got = await c.get(ref);
    await c.close();
    return got !== null;
  };

  it("REFUSES --orphans --apply on a compacted log with no compaction archive, naming the flags; nothing erased", async () => {
    const s = await compactedSeed({ withArchive: false });
    await expect(cmdSweepContent(base(s))).rejects.toThrow(/--compaction-archive/);
    expect(await alive(s.contentDb, s.note)).toBe(true);
  });

  it("picks up archive.db beside --db by default, so the archived event's blob survives", async () => {
    const s = await compactedSeed({ withArchive: true });
    const out = await cmdSweepContent(base(s));
    expect(out).toContain("reclaimed orphans (0)");
    expect(await alive(s.contentDb, s.note)).toBe(true);
  });

  it("--compaction-archive <path> names it explicitly (a missing file is refused, not created)", async () => {
    const s = await compactedSeed({ withArchive: true });
    const moved = join(dir, "elsewhere.db");
    const { renameSync } = await import("node:fs");
    renameSync(join(dir, "archive.db"), moved);
    await expect(cmdSweepContent(base(s))).rejects.toThrow(/--compaction-archive/); // default is gone
    const out = await cmdSweepContent({ ...base(s), compactionArchive: moved });
    expect(out).toContain("reclaimed orphans (0)");
    await expect(
      cmdSweepContent({ ...base(s), compactionArchive: join(dir, "typo.db") })
    ).rejects.toThrow(/no such file/);
    expect(await alive(s.contentDb, s.note)).toBe(true);
  });

  it("--no-compaction-archive is the operator's explicit statement that none exists: the blob is then an orphan", async () => {
    const s = await compactedSeed({ withArchive: false });
    const out = await cmdSweepContent({ ...base(s), noCompactionArchive: true });
    expect(out).toContain("reclaimed orphans (1)");
    expect(await alive(s.contentDb, s.note)).toBe(false);
  });
});
