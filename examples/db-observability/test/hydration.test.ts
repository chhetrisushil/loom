import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_REPAIRED, createHydrator } from "../src/hydration";
import { type TelemetryMcpServer, startTelemetryMcpServer } from "../src/mcpServer";
import { applyHydratedStates, readTelemetry } from "../src/telemetry";
import { buildCore } from "../src/wiring";

// ── The transient blueprint-interpreter hydration ─────────────────────────────
// Hot read path: invokeTransient over the immutable plan (zero events). The
// determinism boundary is crossed only on drift, when a durable repair run is
// recorded. (ADR 0065 / the invokeTransient DX façade.)

let server: TelemetryMcpServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("db-observability transient hydration", () => {
  it("hydrates every projection transiently — correct states, ZERO durable events", async () => {
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

    // The load-bearing guarantee (R1): the hot path is NOT a loom run. No
    // EXECUTION_STARTED, no STEP_*, no snapshot — the event log is empty.
    const events = await hydrator.events("h-1");
    expect(events).toEqual([]);

    // And the dashboard composes from the hydrated (not hand-seeded) telemetry.
    const core = buildCore("h-view");
    applyHydratedStates(core.projectionRuntime, "h-view", states);
    expect(readTelemetry(core.projectionRuntime, "h-view").cpu.current).toBe(91);
    const result = await core.composer.answer("Why is the CPU utilization high?");
    expect(result.what).toContain("91%");
  });

  it("crosses the boundary on drift: transient read fails, a DURABLE repair run is recorded", async () => {
    server = await startTelemetryMcpServer();
    const hydrator = createHydrator(server.url);
    const plan = await hydrator.buildPlan(); // pins the PRE-deploy schema hashes

    server.upgradeReplicationTool(); // the backend deploy — db.replication's hash moves

    const states = await hydrator.hydrate("h-drift", plan);
    expect(states.replication).toEqual({ lagMs: 320, trend: "rising", replicas: 2 });

    const events = await hydrator.events("h-drift");
    // The drift was detected TRANSIENTLY (a retry signal, never a durable fact),
    // so the durable log carries NO STEP_FAILED — only the repair outcome. The
    // full forensic payload rides SCHEMA_REPAIRED (transient transport, durable
    // outcome).
    expect(events.some((e) => e.eventType === "STEP_FAILED")).toBe(false);
    const repaired = events.find((e) => e.eventType === SCHEMA_REPAIRED);
    expect((repaired?.payload as { toolName: string }).toolName).toBe("db.replication");
    expect((repaired?.payload as { observedHash: string }).observedHash).toBeTruthy();

    // The durable repair re-walks the plan: the drifted node under a re-minted id
    // (ADR 0061 — a deliberate retry is a NEW identity), siblings under hydrate#i.
    const stepIds = events
      .filter((e) => e.eventType === "STEP_COMPLETED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    expect(stepIds).toContain("hydrate#2#repair");
    for (let i = 0; i < 4; i++) expect(stepIds).toContain(`reshape#${i}`);
    // The manifest is hash-pinned in the repair run's FIRST event.
    const started = events.find((e) => e.eventType === "EXECUTION_STARTED");
    const input = (started?.payload as { input: { plan: { nodes: unknown[] } } }).input;
    expect(input.plan.nodes).toHaveLength(4);
  });

  it("hydrateTransient surfaces a schemaDrift TypedFailure and still writes nothing", async () => {
    server = await startTelemetryMcpServer();
    const hydrator = createHydrator(server.url);
    const plan = await hydrator.buildPlan();
    server.upgradeReplicationTool();

    // The raw transient walk propagates the typed failure to the caller...
    await expect(hydrator.hydrateTransient(plan)).rejects.toMatchObject({
      channel: "schemaDrift",
    });
    // ...and, being transient, appended nothing anywhere.
    expect(await hydrator.events("unused")).toEqual([]);
  });
});
