// @vitest-environment jsdom
import { createTestApp } from "@loom/testing";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { AGENT_CARDS, CAPABILITY_AGENT } from "../src/agents/definitions";
import { buildCatalog } from "../src/capabilities/catalog";
import { Orchestrator } from "../src/orchestrator/Orchestrator";
import { buildRegistry } from "../src/widgets/registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wire(missionId: string) {
  const catalog = buildCatalog();
  const app = createTestApp({
    surfaces: ["mission", "telemetry"],
    catalog,
    agents: Object.values(AGENT_CARDS),
    capabilityAgents: CAPABILITY_AGENT,
  });
  const orchestrator = new Orchestrator({
    projectionRuntime: app.projectionRuntime,
    missionRuntime: app.runtime,
    catalog,
    bus: app.bus,
    missionId,
  });
  return { orchestrator, projectionRuntime: app.projectionRuntime, bus: app.bus };
}

const buttons = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll("button"));

const findButton = (root: HTMLElement, re: RegExp): HTMLButtonElement | undefined =>
  buttons(root).find((b) => re.test(b.textContent ?? ""));

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function waitForButton(
  root: HTMLElement,
  re: RegExp,
  timeout: number
): Promise<HTMLButtonElement | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const btn = findButton(root, re);
    if (btn) return btn;
    await settle(60);
  }
  return findButton(root, re);
}

describe("Approval UI", () => {
  it("surfaces an Approve control for the medium-risk replica case and completes on click", async () => {
    const { orchestrator, projectionRuntime, bus } = wire("m-ui");
    const container = document.createElement("div");
    document.body.appendChild(container);

    await act(async () => {
      createRoot(container).render(
        <App
          orchestrator={orchestrator}
          projectionRuntime={projectionRuntime}
          registry={buildRegistry()}
          missionId="m-ui"
          agentCards={bus.agentCards()}
        />
      );
    });

    // Start the replica mission via its example chip.
    const chip = findButton(container, /read-replica lag/i);
    expect(chip).toBeTruthy();
    await act(async () => {
      chip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Wait until the mission pauses for approval.
    await waitForButton(container, /^approve$/i, 9000);

    // Switch to the Observability tab — the RiskApproval widget lives only on
    // Mission Control, so this reproduces the operator's blind spot.
    const obsTab = findButton(container, /observability/i);
    await act(async () => {
      obsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(30);

    // The approval must STILL be reachable (the tab-independent banner).
    expect(container.querySelector('[data-testid="approval-bar"]')).toBeTruthy();
    const approve = findButton(container, /^approve$/i);
    expect(
      approve,
      "expected a tab-independent Approve button while awaiting approval"
    ).toBeTruthy();

    await act(async () => {
      approve?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The mission resolves after approval.
    const start = Date.now();
    while (Date.now() - start < 9000) {
      if (projectionRuntime.getState<{ phase: string }>("mission", "m-ui").phase === "resolved")
        break;
      await settle(60);
    }
    expect(projectionRuntime.getState<{ phase: string }>("mission", "m-ui").phase).toBe("resolved");
  }, 30000);
});
