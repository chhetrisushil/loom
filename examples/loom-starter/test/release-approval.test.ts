import { flow$, handler$, step$ } from "@loom/core";
import { retryMiddleware } from "@loom/middleware";
import { createTestApp, waitForPhase } from "@loom/testing";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { releaseApprovalFlow } from "../app/flows/release-approval/flow";
import { SURFACES } from "../src/config";

describe("release-approval flow (new-architecture wiring)", () => {
  it("pauses a medium-risk change for approval, then releases on resume", async () => {
    const app = createTestApp({ surfaces: SURFACES, flows: [releaseApprovalFlow] });

    const handle = await app.runtime.start(releaseApprovalFlow, {
      service: "checkout-api",
      changeType: "hotfix", // medium → gate
    });
    await handle.waitForSuspend();
    await waitForPhase(app.projectionRuntime, "ui", handle.executionId, "awaiting-approval");

    const resumed = await app.runtime.resume(handle.executionId, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "test" },
    });
    const done = await resumed.waitForCompletion();

    expect(done.status).toBe("completed");
    expect(done.variables._output).toMatchObject({
      released: true,
      approvedBy: "test",
      risk: "medium",
    });
    await app.close();
  });

  it("auto-releases a low-risk change without a gate", async () => {
    const app = createTestApp({ surfaces: SURFACES, flows: [releaseApprovalFlow] });
    const handle = await app.runtime.start(releaseApprovalFlow, {
      service: "docs-site",
      changeType: "config", // low → no gate
    });
    const done = await handle.waitForCompletion();
    expect(done.status).toBe("completed");
    expect(done.variables._output).toMatchObject({ released: true, risk: "low" });
    await app.close();
  });

  it("effect middleware retries a flaky effect (retryMiddleware)", async () => {
    // A one-step flow whose effect throws on the first attempt; the retry
    // middleware wired by defineConfig should transparently succeed on retry.
    let attempts = 0;
    const flakyStep = step$({
      id: "flaky",
      name: "Flaky",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean(), attempts: z.number() }),
      handler: handler$(async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("transient");
        return { ok: true, attempts };
      }),
    });
    const runner: FlowRunner<Record<string, never>, { ok: boolean; attempts: number }> = (ctx) =>
      ctx.run(flakyStep, {});
    const flakyFlow = {
      definition: flow$({
        id: "flaky-flow",
        name: "Flaky Flow",
        version: "1.0.0",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean(), attempts: z.number() }),
        steps: [flakyStep],
      }),
      runner,
    } as RegisteredFlow;

    const app = createTestApp({
      flows: [flakyFlow],
      effectMiddleware: [retryMiddleware({ maxRetries: 3, baseDelayMs: 1 })],
    });
    const done = await (await app.runtime.start(flakyFlow, {})).waitForCompletion();
    expect(done.status).toBe("completed");
    expect(attempts).toBe(2); // failed once, retried, succeeded
    await app.close();
  });
});
