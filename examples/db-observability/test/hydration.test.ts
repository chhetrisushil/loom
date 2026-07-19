import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_REPAIRED, createHydrator } from "../src/hydration";
import { type TelemetryMcpServer, startTelemetryMcpServer } from "../src/mcpServer";
import { applyHydratedStates, readTelemetry } from "../src/telemetry";
import { buildCore } from "../src/wiring";

// ── The blueprint-interpreter hydration (fanout$ → mcpInvoke$ → sandboxEval$) ─

let server: TelemetryMcpServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("db-observability durable hydration", () => {
  it("hydrates every projection through MCP + sandboxed reshaping, with per-node step identity", async () => {
    server = await startTelemetryMcpServer();
    const hydrator = createHydrator(server.url);
    const plan = await hydrator.buildPlan();
    expect(plan.nodes.map((n) => n.projectionId).sort()).toEqual([
      "connections",
      "cpu",
      "queries",
      "replication",
    ]);

    const states = await hydrator.hydrate("h-1", plan);

    // The reshaped states match the projection contracts the widgets bind to.
    expect(states.cpu).toEqual({
      current: 91,
      status: "saturated",
      history: [42, 55, 68, 79, 91],
    });
    expect(states.connections).toEqual({ active: 98, waiting: 12, limit: 100, status: "critical" });
    expect(states.replication).toEqual({ lagMs: 320, trend: "rising", replicas: 2 });
    expect((states.queries as { total: number }).total).toBe(3800);

    // Dynamic step identity per the ADR 0061 rule: hydrate#i / reshape#i frames.
    const events = await hydrator.events("h-1");
    const stepIds = events
      .filter((e) => e.eventType === "STEP_COMPLETED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    for (let i = 0; i < 4; i++) {
      expect(stepIds).toContain(`hydrate#${i}`);
      expect(stepIds).toContain(`reshape#${i}`);
    }
    // The plan (the manifest) is hash-pinned in the run's FIRST event.
    const started = events.find((e) => e.eventType === "EXECUTION_STARTED");
    const input = (started?.payload as { input: { nodes: unknown[] } }).input;
    expect(input.nodes).toHaveLength(4);

    // And the dashboard composes from the hydrated (not hand-seeded) telemetry.
    const core = buildCore("h-view");
    applyHydratedStates(core.projectionRuntime, "h-view", states);
    expect(readTelemetry(core.projectionRuntime, "h-view").cpu.current).toBe(91);
    const result = await core.composer.answer("Why is the CPU utilization high?");
    expect(result.what).toContain("91%");
  });

  it("repairs a drifted schema pin in-band: typed failure recorded, siblings substituted, states still correct", async () => {
    server = await startTelemetryMcpServer();
    const hydrator = createHydrator(server.url);
    const plan = await hydrator.buildPlan(); // pins the PRE-deploy schema hashes

    server.upgradeReplicationTool(); // the backend deploy — db.replication's hash moves

    const states = await hydrator.hydrate("h-drift", plan);
    expect(states.replication).toEqual({ lagMs: 320, trend: "rising", replicas: 2 });

    const events = await hydrator.events("h-drift");
    // The drift is a RECORDED typed failure + a SCHEMA_REPAIRED domain event.
    const typed = events.find(
      (e) =>
        e.eventType === "STEP_FAILED" &&
        (e.payload as { channel?: string }).channel === "schemaDrift"
    );
    expect(typed).toBeDefined();
    const repaired = events.find((e) => e.eventType === SCHEMA_REPAIRED);
    expect((repaired?.payload as { toolName: string }).toolName).toBe("db.replication");

    // The repair pass re-ran ONLY the drifted node, under a re-minted id;
    // completed siblings were substituted from the log (exactly one tools/call
    // per tool across the whole run — the drifted invoke never reached the
    // backend, its repair did).
    const stepIds = events
      .filter((e) => e.eventType === "STEP_COMPLETED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    expect(stepIds).toContain("hydrate#2#repair");
    for (const [tool, count] of server.calls) {
      expect(count, `tools/call count for ${tool}`).toBe(1);
    }
  });
});
