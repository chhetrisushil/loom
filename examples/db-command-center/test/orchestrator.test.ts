import { a2uiSurfaceProjection } from "@loom/a2ui";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { InProcessA2ABus } from "../src/a2a/InProcessA2ABus";
import { AGENT_CARDS, CAPABILITY_AGENT, FLEET } from "../src/agents/definitions";
import { buildCatalog } from "../src/capabilities/catalog";
import type { AgentTask, PlanEntry } from "../src/domain";
import { Orchestrator } from "../src/orchestrator/Orchestrator";
import { InMemoryEventStore, InMemorySnapshotStore } from "../src/runtime/browserStores";

const CPU_GOAL = "Why is CPU utilization high? Fix it if remediation is low risk.";
const REPLICA_GOAL =
  "Investigate the read-replica lag issue and fix it if remediation is low risk, else wait for my approval.";

function wire(missionId: string) {
  const effectRuntime = new EffectRuntime();
  const projectionRuntime = new InMemoryProjectionRuntime();
  projectionRuntime.register(a2uiSurfaceProjection("mission"));
  projectionRuntime.register(a2uiSurfaceProjection("telemetry"));

  const missionRuntime = new WorkflowRuntime({
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
    effectRuntime,
    onEvent: (e) => projectionRuntime.handleEvent(e),
  });

  const catalog = buildCatalog();
  catalog.registerInto(missionRuntime);

  const bus = new InProcessA2ABus(missionRuntime);
  for (const agent of FLEET) {
    const card = AGENT_CARDS[agent.id];
    if (card) bus.registerAgent(card);
  }
  for (const [capabilityId, agentId] of Object.entries(CAPABILITY_AGENT)) {
    const cap = catalog.get(capabilityId);
    if (cap) bus.registerCapability(capabilityId, agentId, cap.flow);
  }

  const orchestrator = new Orchestrator({
    projectionRuntime,
    missionRuntime,
    catalog,
    bus,
    missionId,
  });
  return { orchestrator, projectionRuntime };
}

const mission = (pr: InMemoryProjectionRuntime, id: string) =>
  pr.getState<{
    phase: string;
    plan: PlanEntry[];
    tasks: AgentTask[];
    pendingApproval: unknown;
    summary: string;
  }>("mission", id);
const telemetry = (pr: InMemoryProjectionRuntime, id: string) =>
  pr.getState<{ metrics: Record<string, number> }>("telemetry", id);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DB Command Center orchestration", () => {
  it("auto-remediates a low-risk CPU incident end to end", async () => {
    const id = "m-cpu";
    const { orchestrator, projectionRuntime } = wire(id);

    await orchestrator.run(CPU_GOAL);

    const m = mission(projectionRuntime, id);
    // Planner composed the diagnose → assess → apply pipeline.
    expect(m.plan.map((p) => p.capabilityId)).toEqual([
      "diagnose-cpu",
      "assess-remediation",
      "apply-remediation",
    ]);
    // Every agent task completed; nothing waited on a human (low risk auto-fix).
    expect(m.tasks).toHaveLength(3);
    expect(m.tasks.every((t) => t.status === "completed")).toBe(true);
    expect(m.pendingApproval).toBeNull();
    expect(m.phase).toBe("resolved");
    // Remediation drove the CPU gauge back down.
    expect(telemetry(projectionRuntime, id).metrics.cpuPct).toBe(34);
  }, 15000);

  it("pauses a medium-risk replica fix for human approval, then completes", async () => {
    const id = "m-rep";
    const { orchestrator, projectionRuntime } = wire(id);

    const done = orchestrator.run(REPLICA_GOAL);

    // Wait until the risk gate surfaces the approval.
    for (let i = 0; i < 200 && mission(projectionRuntime, id).pendingApproval === null; i++) {
      await sleep(25);
    }
    const paused = mission(projectionRuntime, id);
    expect(paused.pendingApproval).not.toBeNull();
    expect(paused.phase).toBe("awaiting-approval");
    expect(paused.tasks.some((t) => t.status === "awaiting-approval")).toBe(true);

    // Operator approves — resumes the durably-suspended scale flow.
    orchestrator.resolveApproval(true);
    await done;

    const m = mission(projectionRuntime, id);
    expect(m.plan.map((p) => p.capabilityId)).toEqual([
      "diagnose-replica-lag",
      "assess-remediation",
      "scale-read-replicas",
    ]);
    expect(m.phase).toBe("resolved");
    expect(m.tasks.every((t) => t.status === "completed")).toBe(true);
    expect(telemetry(projectionRuntime, id).metrics.lagMs).toBe(180);
  }, 15000);

  it("cancels the pipeline when the operator rejects", async () => {
    const id = "m-rej";
    const { orchestrator, projectionRuntime } = wire(id);

    const done = orchestrator.run(REPLICA_GOAL);
    for (let i = 0; i < 200 && mission(projectionRuntime, id).pendingApproval === null; i++) {
      await sleep(25);
    }
    orchestrator.resolveApproval(false);
    await done;

    const m = mission(projectionRuntime, id);
    expect(m.phase).toBe("rejected");
    expect(m.tasks.some((t) => t.status === "cancelled")).toBe(true);
  }, 15000);
});
