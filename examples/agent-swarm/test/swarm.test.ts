import { flow$, handler$, step$ } from "@loom/core";
import { waitFor } from "@loom/testing";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app";

const REVIEW_GOAL =
  "Audit checkout-service for the 2.4 release; sign off if low risk else wait for my approval.";
const LOW_GOAL = "Audit payments-service for the 2.3.1 patch; sign off automatically if low risk.";

const PLAN = ["scope-audit", "security-audit", "perf-audit", "deps-audit", "signoff-release"];

describe("agent-swarm", () => {
  it("records the composed plan durably in the event log (gap-closer #1)", async () => {
    const { app, conductor } = buildApp({ storage: { kind: "memory" } });
    // low goal auto-signs-off, so no human needed to reach completion
    const res = await conductor.run(LOW_GOAL);

    const events = await app.stores.eventStore.read(`plan-${res.runId}`);
    const composed = events.find((e) => e.eventType === "PLAN_COMPOSED");
    expect(composed).toBeDefined();
    expect(
      (composed?.payload as { steps: { capabilityId: string }[] }).steps.map((s) => s.capabilityId)
    ).toEqual(PLAN);
    // Backstop: the plan also rides EXECUTION_STARTED.input.
    const started = events.find((e) => e.eventType === "EXECUTION_STARTED");
    expect((started?.payload as { input: { steps: unknown[] } }).input.steps).toHaveLength(5);
    await app.close();
  });

  it("fans the 3 specialist audits out in parallel and joins them (gap-closer #2)", async () => {
    const { app, conductor } = buildApp({ storage: { kind: "memory" } });
    const res = await conductor.run(LOW_GOAL);

    expect(res.graph.completed).toBe(true);
    expect(Object.keys(res.graph.byId).sort()).toEqual(["deps", "perf", "security"]);
    for (const id of ["security", "perf", "deps"]) {
      expect(res.graph.byId[id]?.status).toBe("completed");
      // each specialist ran as its own execution
      expect((await app.stores.eventStore.read(`audit-${res.runId}:${id}`)).length).toBeGreaterThan(
        0
      );
    }
    await app.close();
  });

  it("suspends for human sign-off on medium risk, then completes on approval", async () => {
    const { app, conductor } = buildApp({ storage: { kind: "memory" } });
    const done = conductor.run(REVIEW_GOAL);

    await waitFor(() => conductor.getState().pending !== null, { timeoutMs: 5000, intervalMs: 25 });
    const pending = conductor.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending?.risk).toBe("medium");

    conductor.resolveApproval(true);
    const res = await done;
    expect(res.signoff.signedOff).toBe(true);
    expect(res.phase).toBe("resolved");
    await app.close();
  });

  it("auto-approves a low-risk release without suspending", async () => {
    const { app, conductor } = buildApp({ storage: { kind: "memory" } });
    const res = await conductor.run(LOW_GOAL);
    expect(res.risk).toBe("low");
    expect(res.signoff.signedOff).toBe(true);
    expect(res.signoff.approvedBy).toBe("risk-policy"); // auto, not a human
    await app.close();
  });

  it("the read-only guardrail denies a deployment effect (policy$ enforcement)", async () => {
    const { app } = buildApp({ storage: { kind: "memory" } });
    // A rogue flow that tries to run a `deploy-*` effect — the fleet is read-only, so the K2 ring
    // denies it before it can run (the authorizer is consulted before the effect registry, so even
    // an unregistered effect is denied). This is the enforcement the FLEET_GUARDRAIL provides.
    const deployStep = step$({
      id: "deploy-prod",
      name: "Deploy to prod",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: handler$(async () => ({})),
    });
    const rogueFlow: RegisteredFlow = {
      definition: flow$({
        id: "rogue-deploy",
        name: "Rogue Deploy",
        version: "1.0.0",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        steps: [deployStep],
      }),
      runner: (async (ctx) => ctx.run(deployStep as never, {})) as FlowRunner<unknown, unknown>,
    } as RegisteredFlow;
    const handle = await app.runtime.start(rogueFlow, {});
    await expect(handle.waitForCompletion()).rejects.toThrow(/denied/i);
    await app.close();
  });
});
