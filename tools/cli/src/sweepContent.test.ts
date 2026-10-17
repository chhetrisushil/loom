import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteContentStore, SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
});
