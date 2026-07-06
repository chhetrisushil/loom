import { describe, expect, it, vi } from "vitest";
import { autoApprovalAllowed, decideApproval } from "./approval";
import { dispatchPlan } from "./dispatchPlan";

describe("autoApprovalAllowed", () => {
  it("matches the policy phrasing in a goal", () => {
    expect(autoApprovalAllowed("Fix it if remediation is low risk")).toBe(true);
    expect(autoApprovalAllowed("auto-fix the CPU issue")).toBe(true);
    expect(autoApprovalAllowed("Investigate and wait for my approval")).toBe(false);
  });
});

describe("decideApproval", () => {
  it("auto-approves a low-risk action when the goal permits it", async () => {
    const onAutoApprove = vi.fn();
    const waitForManual = vi.fn();
    const decision = await decideApproval(
      { goal: "fix if low risk", riskLevel: "low" },
      { onAutoApprove, onManualRequired: vi.fn(), waitForManual }
    );
    expect(decision).toEqual({ approved: true, approvedBy: "risk-policy" });
    expect(onAutoApprove).toHaveBeenCalledTimes(1);
    expect(waitForManual).not.toHaveBeenCalled();
  });

  it("defers to the human for a medium-risk action", async () => {
    const onManualRequired = vi.fn();
    const decision = await decideApproval(
      { goal: "fix if low risk", riskLevel: "medium" },
      {
        onManualRequired,
        waitForManual: async () => ({ approved: true, approvedBy: "operator" }),
      }
    );
    expect(decision.approvedBy).toBe("operator");
    expect(onManualRequired).toHaveBeenCalledTimes(1);
  });

  it("defers to the human when the goal forbids auto-approval, even at low risk", async () => {
    const decision = await decideApproval(
      { goal: "wait for my approval", riskLevel: "low" },
      { waitForManual: async () => ({ approved: false, approvedBy: "operator" }) }
    );
    expect(decision.approved).toBe(false);
  });
});

describe("dispatchPlan", () => {
  it("routes, plans, dispatches each step in order, and absorbs results", async () => {
    const order: string[] = [];
    const steps = await dispatchPlan<{ id: string }>({
      goal: "do it",
      route: async () => "cap-a",
      onRouted: (r) => order.push(`routed:${r}`),
      plan: async () => ({ steps: [{ id: "a" }, { id: "b" }] }),
      onPlanned: (s) => order.push(`planned:${s.length}`),
      dispatch: async (step) => {
        order.push(`dispatch:${step.id}`);
        return { status: "completed", artifact: step.id.toUpperCase() };
      },
      onResult: (_step, result) => order.push(`result:${result.artifact}`),
    });
    expect(steps).toHaveLength(2);
    expect(order).toEqual([
      "routed:cap-a",
      "planned:2",
      "dispatch:a",
      "result:A",
      "dispatch:b",
      "result:B",
    ]);
  });

  it("stops early when isTerminal turns true (e.g. a rejection)", async () => {
    const dispatched: string[] = [];
    let rejected = false;
    await dispatchPlan<{ id: string }>({
      goal: "g",
      plan: async () => ({ steps: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
      dispatch: async (step) => {
        dispatched.push(step.id);
        if (step.id === "b") rejected = true;
        return { status: "completed", artifact: null };
      },
      isTerminal: () => rejected,
    });
    expect(dispatched).toEqual(["a", "b"]); // c never dispatched
  });
});
