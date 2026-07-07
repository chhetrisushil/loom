import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForPhase } from "@loom/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ServerApp, createApp } from "../src/server/app";
import { STRATEGIES } from "../src/warroom/strategies";

const COMPLEX_GOAL = "Add a NOT NULL region column to the 40M-row orders table.";
const SIMPLE_GOAL =
  "Add a nullable notes column to the orders table (metadata-only); apply automatically if low risk.";

describe("schema migration planner (durable, headless)", () => {
  let dataDir: string;
  let app: ServerApp;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "migration-"));
    app = createApp({ dataDir, missionId: "m-test" });
  });
  afterEach(() => {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const mission = () => app.projectionRuntime.getState<{ phase?: string }>("mission", "m-test");
  const telemetry = () =>
    app.projectionRuntime.getState<{ metrics: Record<string, number> }>("telemetry", "m-test");
  // Reach a mission phase, failing loudly on timeout (vs the old silent poll loop).
  const reachPhase = (phase: string) =>
    waitForPhase(app.projectionRuntime, "mission", "m-test", phase, {
      timeoutMs: 10000,
      intervalMs: 25,
    });

  it("forks the gate into candidate strategies, simulates each, promotes a winner (no merge)", async () => {
    void app.orchestrator.run(COMPLEX_GOAL);

    // The complex migration reaches the gate and opens the Migration Board.
    await reachPhase("awaiting-branches");
    expect(mission().phase).toBe("awaiting-branches");

    const prepared = app.orchestrator.branchSurface();
    expect(prepared.branches).toHaveLength(STRATEGIES.length);
    expect(prepared.branches.every((b) => b.status === "proposed")).toBe(true);
    const parentId = prepared.parentExecutionId;
    const forkPoint = prepared.forkPoint;
    expect(parentId).toBeTruthy();
    expect(forkPoint).not.toBeNull();

    // Phase 2 — fork + simulate every candidate concurrently (against a shadow schema).
    await app.orchestrator.exploreBranches();
    expect(mission().phase).toBe("branches-ready");

    const explored = app.orchestrator.branchSurface();
    const outcomes = explored.branches.map((b) => b.outcome);
    // Every branch produced a distinct projected outcome (a real fork happened).
    expect(outcomes.every((o) => o !== undefined)).toBe(true);
    const durations = new Set(outcomes.map((o) => o?.durationMinutes));
    expect(durations.size).toBe(STRATEGIES.length);
    expect(explored.branches.every((b) => b.outcome?.simulated === true)).toBe(true);
    // Every branch's live backfill progress streamed all the way to 100%.
    expect(explored.branches.every((b) => b.progress === 100)).toBe(true);

    // Parent is untouched: `main` still names the suspended gate at the fork point,
    // and one child ref exists per candidate strategy.
    const mainRef = explored.refs.find((r) => r.name === "main");
    expect(mainRef?.executionId).toBe(parentId);
    expect(mainRef?.tip).toBe(forkPoint);
    for (const s of STRATEGIES) {
      expect(explored.refs.some((r) => r.name === `spec/${s.id}`)).toBe(true);
    }

    // Patches were broadcast to (would-be) SSE clients as branches resolved.
    const frames: unknown[] = [];
    app.subscribeBroadcast((f) => frames.push(f));

    // Phase 3 — promote the winner and apply it for real.
    await app.orchestrator.promoteBranch("online-ddl");
    await reachPhase("resolved");
    expect(mission().phase).toBe("resolved");

    const committed = app.orchestrator.branchSurface();
    const winner = committed.branches.find((b) => b.strategy === "online-ddl");
    expect(winner?.status).toBe("committed");
    expect(winner?.outcome?.applied).toBe(true);
    expect(winner?.outcome?.simulated).toBe(false);
    // The losing branches were kept (rejected, not deleted) as the audit trail.
    expect(committed.branches.filter((b) => b.status === "rejected")).toHaveLength(
      STRATEGIES.length - 1
    );

    // `main` moved off the parent onto the real, committed apply — a pointer move,
    // no merge. Lineage records every fork off the gate (3 specs + 1 commit).
    const finalMain = committed.refs.find((r) => r.name === "main");
    expect(finalMain?.executionId).not.toBe(parentId);
    expect(committed.lineageCount).toBeGreaterThanOrEqual(STRATEGIES.length + 1);

    // The real apply folded its realized cost and was persisted to SQLite on disk.
    expect(telemetry().metrics.durationMinutes).toBe(22); // online-ddl
    expect(frames.some((f) => (f as { kind?: string }).kind === "patch")).toBe(true);
    expect(existsSync(join(dataDir, "events.db"))).toBe(true);
    expect(existsSync(join(dataDir, "branches.db"))).toBe(true);
  }, 30000);

  it("auto-applies a simple metadata-only migration without branching", async () => {
    await app.orchestrator.run(SIMPLE_GOAL);
    expect(mission().phase).toBe("resolved");
    // The simple path never opens the Migration Board.
    expect(app.orchestrator.branchSurface().phase).toBe("idle");
  }, 30000);
});
