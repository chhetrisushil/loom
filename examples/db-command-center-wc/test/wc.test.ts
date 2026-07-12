import type { WidgetAction } from "@loom/blueprint-runtime";
// @vitest-environment jsdom
import type { AgentCard } from "@loom/plugin-a2a";
import { createTestApp } from "@loom/testing";
import { describe, expect, it } from "vitest";
import { AGENT_CARDS, CAPABILITY_AGENT, FLEET } from "../src/agents/definitions";
import { MissionControlBlueprint } from "../src/blueprints/MissionControlBlueprint";
import { buildCatalog } from "../src/capabilities/catalog";
import { mountBlueprint } from "../src/dom/BlueprintDom";
import { defineWidgetElements } from "../src/dom/elements";
import { Orchestrator } from "../src/orchestrator/Orchestrator";

const REPLICA_GOAL =
  "Investigate the read-replica lag issue and fix it if remediation is low risk, else wait for my approval.";

function wire(missionId: string) {
  const catalog = buildCatalog();
  const app = createTestApp({
    surfaces: ["mission", "telemetry"],
    catalog,
    agents: FLEET.map((a) => AGENT_CARDS[a.id]).filter((c): c is AgentCard => c !== undefined),
    capabilityAgents: CAPABILITY_AGENT,
  });
  const orchestrator = new Orchestrator({
    projectionRuntime: app.projectionRuntime,
    missionRuntime: app.runtime,
    catalog,
    bus: app.bus,
    missionId,
  });
  return { orchestrator, projectionRuntime: app.projectionRuntime };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const findApprove = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("button")).find((b) => /^approve$/i.test(b.textContent ?? ""));

describe("Web Components render layer", () => {
  it("renders custom-element widgets and drives the human-in-the-loop approval", async () => {
    defineWidgetElements();
    const id = "wc-mission";
    const { orchestrator, projectionRuntime } = wire(id);

    const handleAction = (a: WidgetAction): void => {
      if (a.type === "APPROVE") orchestrator.resolveApproval(true);
      if (a.type === "REJECT") orchestrator.resolveApproval(false);
    };

    const mounted = mountBlueprint(MissionControlBlueprint, projectionRuntime, id, handleAction);
    document.body.appendChild(mounted.element);

    // Custom elements are defined and instantiated.
    expect(mounted.element.querySelector("dcc-agent-task-list")).toBeTruthy();
    expect(mounted.element.querySelector("dcc-plan-flow")).toBeTruthy();
    expect(mounted.element.querySelector("dcc-risk-approval")).toBeTruthy();

    void orchestrator.run(REPLICA_GOAL);

    // Granular updates: the plan and task widgets fill in as the mission runs.
    for (let i = 0; i < 200 && !findApprove(mounted.element); i++) await sleep(25);

    const planSteps = mounted.element.querySelectorAll("dcc-plan-flow .plan-step");
    expect(planSteps.length).toBe(3);
    const taskRows = mounted.element.querySelectorAll("dcc-agent-task-list .task-row");
    expect(taskRows.length).toBeGreaterThan(0);

    // The RiskApproval custom element surfaced an Approve button; click it.
    const approve = findApprove(mounted.element);
    expect(approve, "expected an Approve button on the RiskApproval element").toBeTruthy();
    approve?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Approval resumes the durably-suspended scale flow to completion.
    const start = Date.now();
    while (Date.now() - start < 9000) {
      if (projectionRuntime.getState<{ phase: string }>("mission", id).phase === "resolved") break;
      await sleep(30);
    }
    expect(projectionRuntime.getState<{ phase: string }>("mission", id).phase).toBe("resolved");

    mounted.dispose();
  }, 30000);
});
