import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor, waitForPhase } from "@loom/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ServerApp, createApp } from "../src/server/app";
import type { ServerFrame } from "../src/wire";

const CPU_GOAL = "Why is CPU utilization high? Fix it if remediation is low risk.";
const REPLICA_GOAL =
  "Investigate the read-replica lag issue and fix it if remediation is low risk, else wait for my approval.";

describe("server app (durable, headless)", () => {
  let dataDir: string;
  let app: ServerApp;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "dcc-server-"));
    app = createApp({ dataDir, missionId: "m-test" });
  });
  afterEach(() => {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Reach a mission phase, failing loudly on timeout (vs the old silent poll loop).
  const reachPhase = (phase: string) =>
    waitForPhase(app.projectionRuntime, "mission", "m-test", phase, {
      timeoutMs: 10000,
      intervalMs: 25,
    });

  it("runs a mission on SQLite, streams patches, and resolves after HTTP-style approval", async () => {
    const frames: ServerFrame[] = [];
    app.subscribeBroadcast((f) => frames.push(f));

    const mission = () =>
      app.projectionRuntime.getState<{ phase?: string; pendingApproval?: unknown }>(
        "mission",
        "m-test"
      );
    const telemetry = () =>
      app.projectionRuntime.getState<{ metrics: Record<string, number> }>("telemetry", "m-test");

    void app.orchestrator.run(REPLICA_GOAL);

    // The medium-risk replica fix pauses for approval.
    await waitFor(() => mission().pendingApproval != null, { timeoutMs: 10000, intervalMs: 25 });
    expect(mission().pendingApproval).not.toBeNull();
    expect(mission().phase).toBe("awaiting-approval");

    // Patches were broadcast to (would-be) SSE clients as the mission progressed.
    expect(frames.some((f) => f.kind === "patch")).toBe(true);

    // The connect-time snapshot is a valid serialized ProjectionSnapshot.
    const snap = JSON.parse(app.snapshot()) as {
      executionId: string;
      states: Record<string, unknown>;
    };
    expect(snap.executionId).toBe("m-test");
    expect(Object.keys(snap.states).sort()).toEqual(["mission", "telemetry"]);

    // Operator approves (what POST /approve does) → durable flow resumes.
    app.orchestrator.resolveApproval(true);
    await reachPhase("resolved");

    expect(mission().phase).toBe("resolved");
    expect(telemetry().metrics.lagMs).toBe(180);

    // Durability: the event log was persisted to SQLite on disk.
    expect(existsSync(join(dataDir, "events.db"))).toBe(true);
  }, 30000);

  it("re-runs missions on the same SQLite store without execution-id collisions", async () => {
    const mission = () => app.projectionRuntime.getState<{ phase?: string }>("mission", "m-test");

    // First mission: low-risk CPU auto-remediates (no human approval) and fully
    // resolves — so awaiting run() is safe here.
    await app.orchestrator.run(CPU_GOAL);
    expect(mission().phase).toBe("resolved");

    // Second mission on the SAME durable store. With reused execution ids this
    // throws `UNIQUE constraint failed: events.execution_id, events.sequence`;
    // the per-run nonce keeps every run's ids distinct.
    let rejected: unknown = null;
    const second = app.orchestrator.run(REPLICA_GOAL).catch((e) => {
      rejected = e;
    });
    await reachPhase("awaiting-approval");
    expect(rejected).toBeNull();
    expect(mission().phase).toBe("awaiting-approval");

    app.orchestrator.resolveApproval(true);
    await second;
    await reachPhase("resolved");
    expect(rejected).toBeNull();
    expect(mission().phase).toBe("resolved");
  }, 30000);
});
