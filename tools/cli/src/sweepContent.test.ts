import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteContentStore, SqliteEventStore } from "@loom/plugin-sqlite";
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
    const content = new SqliteContentStore(contentDb);
    const enc = (s: string) => new TextEncoder().encode(s);

    const evidence = await content.put(enc("EXPLAIN plan"));
    const telemetry = await content.put(enc("pg_stat sample"));
    const old = Date.now() - 90 * DAY;
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
    expect(dry).toContain("would-reclaim (1)");
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
});
