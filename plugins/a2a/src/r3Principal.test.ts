import { flow$, handler$, step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, executionAccessPolicy } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type A2AServer, createA2AServer } from "./A2AServer";
import { LoomAgentExecutor } from "./AgentExecutor";
import type { A2ATask } from "./types";

// R3 round 1 (P2-3) — an A2A server must be usable under a runtime that fails closed.

const echoStep = step$({
  id: "echo",
  name: "Echo",
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ reply: z.string() }),
  handler: handler$(async (input: { prompt: string }) => ({ reply: `Echo: ${input.prompt}` })),
});
const runner: FlowRunner<{ prompt: string }, { reply: string }> = async (ctx, input) => {
  const out = (await ctx.run(echoStep, { prompt: input.prompt })) as { reply: string };
  await ctx.suspend({ on: "InputProvided", correlationKey: input.prompt });
  return out;
};
const flow: RegisteredFlow = {
  definition: flow$({
    id: "g",
    name: "g",
    version: "1.0.0",
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ reply: z.string() }),
    steps: [echoStep],
  }),
  runner: runner as FlowRunner<unknown, unknown>,
};
const strictRuntime = () => {
  const rt = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    executionAuthorizer: executionAccessPolicy(),
    executionAuthz: { requirePrincipal: true },
  });
  rt.registerFlow(flow.definition, flow.runner);
  return rt;
};
const alice = { actor: "alice", tenant: "t1" };
const task = (id: string): A2ATask => ({
  id,
  message: { role: "user", parts: [{ type: "text", text: "hi" }] },
});

describe("A2A under strict execution authz", () => {
  let server: A2AServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("LoomAgentExecutor: submit/get/provideInput act as the given principal; none is refused", async () => {
    const executor = new LoomAgentExecutor(strictRuntime(), flow);
    await expect(executor.submit(task("t0"))).rejects.toMatchObject({
      name: "ExecutionDeniedError",
    });
    await executor.submit(task("t1"), { principal: alice });
    await new Promise((r) => setTimeout(r, 20));
    expect((await executor.get("t1", { principal: alice }))?.status).toBe("working");
    await expect(executor.get("t1")).rejects.toMatchObject({ name: "ExecutionDeniedError" });
    await expect(
      executor.provideInput("t1", { eventType: "InputProvided", payload: {} })
    ).rejects.toMatchObject({ name: "ExecutionDeniedError" });
    await executor.provideInput(
      "t1",
      { eventType: "InputProvided", payload: {} },
      { principal: alice }
    );
  });

  it("createA2AServer: resolvePrincipal maps the authenticated request to the principal", async () => {
    server = createA2AServer(
      strictRuntime(),
      flow,
      { name: "G", version: "1.0.0", capabilities: {}, skills: [] },
      {
        port: 0,
        authorize: (req) => req.headers.authorization === "Bearer alice",
        resolvePrincipal: (req) =>
          req.headers.authorization === "Bearer alice" ? alice : undefined,
      }
    );
    await server.start();
    const h = { authorization: "Bearer alice", "content-type": "application/json" };
    const sent = await fetch(`${server.url}/tasks/send`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(task("s1")),
    });
    expect(sent.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const got = await fetch(`${server.url}/tasks/s1`, { headers: h });
    expect(got.status).toBe(200);
  });

  it("createA2AServer without resolvePrincipal is anonymous and refused by a strict runtime", async () => {
    server = createA2AServer(
      strictRuntime(),
      flow,
      { name: "G", version: "1.0.0", capabilities: {}, skills: [] },
      { port: 0, insecure: true, warn: () => {} }
    );
    await server.start();
    const sent = await fetch(`${server.url}/tasks/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task("s2")),
    });
    expect(sent.status).toBeGreaterThanOrEqual(400);
  });
});
