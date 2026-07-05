import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ServerApp, createApp } from "../src/server/app";
import type { ServerFrame } from "../src/wire";

const REPLICA_GOAL =
  "Investigate the read-replica lag issue and fix it if remediation is low risk, else wait for my approval.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    for (let i = 0; i < 200 && mission().pendingApproval == null; i++) await sleep(25);
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
    for (let i = 0; i < 200 && mission().phase !== "resolved"; i++) await sleep(25);

    expect(mission().phase).toBe("resolved");
    expect(telemetry().metrics.lagMs).toBe(180);

    // Durability: the event log was persisted to SQLite on disk.
    expect(existsSync(join(dataDir, "events.db"))).toBe(true);
  }, 30000);
});
