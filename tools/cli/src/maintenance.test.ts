import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import { SqliteBranchRegistry, SqliteEventStore, SqliteLeaseStore } from "@loom/plugin-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cmdBranchesPrune, cmdBranchesRetire, cmdRecover } from "./maintenance";

// ── The maintenance passes as operator commands ──────────────────────────────
//
// All three write, so all three are dry by default. The tests worth having are the REFUSALS:
// each pass turns on a judgement loom will not make for you, and a command that guessed
// instead would be worse than no command.

function evt(id: string, sequence: number, eventType: string, ageMs: number): EventEnvelope {
  return {
    id: `${id}-${sequence}`,
    executionId: id,
    workflowId: "wf",
    eventType,
    sequence,
    timestamp: Date.now() - ageMs,
    payload: sequence === 0 ? { input: {} } : {},
  };
}

describe("loom recover", () => {
  let dir: string;
  let db: string;
  let leasesDb: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-recover-"));
    db = join(dir, "events.db");
    leasesDb = join(dir, "leases.db");
    const store = new SqliteEventStore(db);
    await store.append(evt("stuck-1", 0, "EXECUTION_STARTED", 3_600_000));
    await store.append(evt("done-1", 0, "EXECUTION_STARTED", 3_600_000));
    await store.append(evt("done-1", 1, "EXECUTION_COMPLETED", 3_600_000));
    store.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses to guess what abandoned means, and says both ways to tell it", async () => {
    const out = await cmdRecover({ db, apply: false });
    expect(out).toContain("will not guess");
    expect(out).toContain("timers.leases");
    expect(out).toContain("--stale");
    // The reason, not just the rule: this is why no default is defensible.
    expect(out).toContain("byte-identical");
  });

  it("previews with --stale, naming the rule as the operator's own", async () => {
    const out = await cmdRecover({ db, stale: "15m", apply: false });
    expect(out).toContain("DRY RUN");
    expect(out).toContain("stuck-1");
    expect(out).toContain("would recover");
    expect(out).toContain("your rule, not loom's");
    // Terminal executions are not abandoned, they are finished.
    expect(out).not.toContain("done-1");
  });

  it("refuses --apply on the shorthand: re-driving needs the app's flows", async () => {
    const out = await cmdRecover({ db, stale: "15m", apply: true });
    expect(out).toContain("--apply needs --config");
    expect(out).toContain("runs its steps");
    // ...and it says what the shorthand CAN do, rather than just refusing.
    expect(out).toContain("can preview");
  });

  it("--max-recoveries lists executions whose last N re-drives made no progress", async () => {
    // Two re-drives at the tail and nothing since: a poison execution.
    const store = new SqliteEventStore(db);
    await store.append(evt("stuck-1", 1, "STEP_STARTED", 3_600_000));
    await store.append(evt("stuck-1", 2, "EXECUTION_RECOVERED", 3_000_000));
    await store.append(evt("stuck-1", 3, "EXECUTION_RECOVERED", 2_000_000));
    store.close();

    const out = await cmdRecover({ db, stale: "15m", maxRecoveries: 2, apply: false });
    expect(out).toContain("exhausted: 1");
    expect(out).toContain("stuck-1 (2)");
    expect(out).not.toContain("would recover: 1");

    // Below the bound it is an ordinary candidate.
    const below = await cmdRecover({ db, stale: "15m", maxRecoveries: 3, apply: false });
    expect(below).toContain("would recover: 1");
    expect(below).not.toContain("exhausted");
  });

  it("refuses --max-recoveries 0: it would skip every execution", async () => {
    const out = await cmdRecover({ db, stale: "15m", maxRecoveries: 0, apply: false });
    expect(out).toContain("must be an integer ≥ 1");
  });

  it("uses expired leases as evidence when the app wires them", async () => {
    const leases = new SqliteLeaseStore(leasesDb);
    // Expired 10 minutes ago: the node holding it stopped saying it was alive.
    await leases.acquire("stuck-1", "dead-node", 1, Date.now() - 600_000);
    leases.close();

    const out = await cmdRecover({ db, leases: leasesDb, apply: false });
    expect(out).toContain("evidence: expired leases");
    expect(out).toContain("stuck-1");
  });
});

describe("loom branches", () => {
  let dir: string;
  let db: string;
  let branchesDb: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-branches-"));
    db = join(dir, "events.db");
    branchesDb = join(dir, "branches.db");
    const store = new SqliteEventStore(db);
    await store.append(evt("live-1", 0, "EXECUTION_STARTED", 60_000));
    store.close();

    const registry = new SqliteBranchRegistry(branchesDb);
    const now = Date.now();
    await registry.putRef({
      name: "main",
      executionId: "gone-1",
      tip: 0,
      createdAt: now,
      updatedAt: now,
    });
    await registry.putRef({
      name: "spec/live",
      executionId: "live-1",
      tip: 0,
      createdAt: now,
      updatedAt: now,
    });
    await registry.putRef({
      name: "spec/ghost",
      executionId: "gone-2",
      tip: 0,
      createdAt: now,
      updatedAt: now,
    });
    registry.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prune previews, and deletes nothing without --apply", async () => {
    const out = await cmdBranchesPrune({ db, branches: branchesDb, apply: false });
    expect(out).toContain("DRY RUN");
    expect(out).toContain("spec/ghost");
    expect(out).toContain("would delete");
    // main dangles too, but deleting it turns a loud problem into a silent one.
    expect(out).toContain("protected but dangling: main");

    const registry = new SqliteBranchRegistry(branchesDb);
    expect(await registry.listRefs()).toHaveLength(3);
    registry.close();
  });

  it("prune deletes under --apply, leaving protected and live refs", async () => {
    const out = await cmdBranchesPrune({ db, branches: branchesDb, apply: true });
    expect(out).toContain("deleted");

    const registry = new SqliteBranchRegistry(branchesDb);
    const names = (await registry.listRefs()).map((r) => r.name).sort();
    expect(names).toEqual(["main", "spec/live"]);
    registry.close();
  });

  it("says which half to fix when no registry is reachable", async () => {
    const out = await cmdBranchesPrune({ db, apply: false });
    expect(out).toContain("--branches");
    expect(out).toContain("--config");
  });

  it("retire refuses without --stale — a parked branch is an open question", async () => {
    const out = await cmdBranchesRetire({
      db,
      branches: branchesDb,
      parent: "live-1",
      apply: false,
    });
    expect(out).toContain("--stale");
    expect(out).toContain("not garbage");
  });
});
