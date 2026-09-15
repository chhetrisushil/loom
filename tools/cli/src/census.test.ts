import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import { SqliteEventStore, SqliteLeaseStore } from "@loom/plugin-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cmdCensus, parseBuckets } from "./census";

// ── `loom census` — the operator half of #408 ────────────────────────────────
//
// The library pass made the deferral measurable; this makes the measurement reachable. A
// number that requires writing TypeScript against your own composition root is a number
// nobody looks at.

function evt(
  executionId: string,
  sequence: number,
  eventType: string,
  ageMs: number
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    executionId,
    workflowId: "wf",
    eventType,
    sequence,
    timestamp: Date.now() - ageMs,
    payload: sequence === 0 ? { input: {} } : {},
  };
}

describe("loom census", () => {
  let dir: string;
  let db: string;
  let leasesDb: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-census-"));
    db = join(dir, "events.db");
    leasesDb = join(dir, "leases.db");
    const store = new SqliteEventStore(db);
    // Two stuck for ~7h, one finished, one stuck for a minute.
    for (const id of ["old-a", "old-b"]) {
      await store.append(evt(id, 0, "EXECUTION_STARTED", 7 * 3_600_000));
    }
    await store.append(evt("fresh", 0, "EXECUTION_STARTED", 60_000));
    await store.append(evt("done", 0, "EXECUTION_STARTED", 7 * 3_600_000));
    await store.append(evt("done", 1, "EXECUTION_COMPLETED", 7 * 3_600_000));
    store.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("bands what is in flight and ignores what finished", async () => {
    const out = await cmdCensus(db);
    expect(out).toContain("4 execution(s) scanned, 3 in flight");
    expect(out).toMatch(/in flight ≥ 6h\s+2/);
    // `fresh` is a minute old: in flight, but below every default band. Bands are thresholds,
    // not a partition of everything running — the header carries the total.
    expect(out).toMatch(/in flight ≥ 5m\s+2/);
    expect(out).toContain("old-a");
  });

  it("says lease coverage was NOT ASKED rather than reporting zeros", async () => {
    const out = await cmdCensus(db);
    expect(out).toContain("not asked");
    expect(out).not.toContain("no lease at all");
  });

  it("counts what nothing is watching — the number #408 turns on", async () => {
    const leases = new SqliteLeaseStore(leasesDb);
    await leases.acquire("old-a", "node-1", 30 * 60_000); // held and renewing
    await leases.acquire("old-b", "node-2", 1, Date.now() - 60_000); // lapsed
    await leases.close();

    const out = await cmdCensus(db, { leases: leasesDb });
    expect(out).toMatch(/lease held \(renewing\):\s+1/);
    expect(out).toMatch(/lease expired:\s+1/);
    expect(out).toMatch(/no lease at all:\s+1/); // `fresh` — started by nothing that leases
  });

  it("parses human bucket specs, and refuses nonsense", () => {
    expect(parseBuckets("30s,5m,6h,2d")).toEqual([30_000, 300_000, 21_600_000, 172_800_000]);
    expect(parseBuckets("1500")).toEqual([1500]);
    expect(() => parseBuckets("soon")).toThrow(/invalid bucket/);
  });
});
