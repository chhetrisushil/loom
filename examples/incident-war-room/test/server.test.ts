import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ServerApp, createApp } from "../src/server/app";
import { STRATEGIES } from "../src/warroom/strategies";

const CPU_GOAL = "Why is CPU utilization high? Fix it if remediation is low risk.";
const REPLICA_GOAL =
  "Investigate the read-replica lag issue and fix it if remediation is low risk, else wait for my approval.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("incident war room (durable, headless)", () => {
  let dataDir: string;
  let app: ServerApp;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "war-room-"));
    app = createApp({ dataDir, missionId: "m-test" });
  });
  afterEach(() => {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const mission = () => app.projectionRuntime.getState<{ phase?: string }>("mission", "m-test");
  const telemetry = () =>
    app.projectionRuntime.getState<{ metrics: Record<string, number> }>("telemetry", "m-test");
  const waitFor = async (pred: () => boolean, tries = 400): Promise<void> => {
    for (let i = 0; i < tries && !pred(); i++) await sleep(25);
  };

  it("forks the gate into candidate branches, simulates each, promotes a winner (no merge)", async () => {
    void app.orchestrator.run(REPLICA_GOAL);

    // The replica remediation reaches the gate and opens the War Room.
    await waitFor(() => mission().phase === "awaiting-branches");
    expect(mission().phase).toBe("awaiting-branches");

    const prepared = app.orchestrator.branchSurface();
    expect(prepared.branches).toHaveLength(STRATEGIES.length);
    expect(prepared.branches.every((b) => b.status === "proposed")).toBe(true);
    const parentId = prepared.parentExecutionId;
    const forkPoint = prepared.forkPoint;
    expect(parentId).toBeTruthy();
    expect(forkPoint).not.toBeNull();

    // Phase 2 — fork + simulate every candidate concurrently.
    await app.orchestrator.exploreBranches();
    expect(mission().phase).toBe("branches-ready");

    const explored = app.orchestrator.branchSurface();
    const outcomes = explored.branches.map((b) => b.outcome);
    // Every branch produced a distinct projected outcome (a real fork happened).
    expect(outcomes.every((o) => o !== undefined)).toBe(true);
    const lags = new Set(outcomes.map((o) => o?.projectedLagMs));
    expect(lags.size).toBe(STRATEGIES.length);
    expect(explored.branches.every((b) => b.outcome?.simulated === true)).toBe(true);

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
    // (subscribe late is fine — promote still emits patches below)
    app.subscribeBroadcast((f) => frames.push(f));

    // Phase 3 — promote the winner and apply it for real.
    await app.orchestrator.promoteBranch("scale-replicas");
    await waitFor(() => mission().phase === "resolved");
    expect(mission().phase).toBe("resolved");

    const committed = app.orchestrator.branchSurface();
    const winner = committed.branches.find((b) => b.strategy === "scale-replicas");
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

    // The real apply recovered the metric and was persisted to SQLite on disk.
    expect(telemetry().metrics.lagMs).toBe(180);
    expect(frames.some((f) => (f as { kind?: string }).kind === "patch")).toBe(true);
    expect(existsSync(join(dataDir, "events.db"))).toBe(true);
    expect(existsSync(join(dataDir, "branches.db"))).toBe(true);
  }, 30000);

  it("auto-remediates a low-risk CPU incident without branching", async () => {
    await app.orchestrator.run(CPU_GOAL);
    expect(mission().phase).toBe("resolved");
    // The CPU path never opens the War Room.
    expect(app.orchestrator.branchSurface().phase).toBe("idle");
  }, 30000);
});
