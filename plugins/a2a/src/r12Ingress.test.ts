import { networkInterfaces } from "node:os";
import { flow$, handler$, step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type A2AServer, type A2AServerOptions, createA2AServer } from "./A2AServer";
import { LoomAgentExecutor, principalNamespace } from "./AgentExecutor";
import type { A2ATask } from "./types";

// R12 — the A2A server is untrusted-network ingress: secure by default, tasks owned by their
// creator.

const echoStep = step$({
  id: "echo",
  name: "Echo",
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ reply: z.string() }),
  handler: handler$(async (input: { prompt: string }) => ({ reply: `Echo: ${input.prompt}` })),
});
const runner: FlowRunner<{ prompt: string }, { reply: string }> = async (ctx, input) => {
  const out = (await ctx.run(echoStep, { prompt: input.prompt })) as { reply: string };
  if (input.prompt.startsWith("wait")) {
    await ctx.suspend({ on: "InputProvided", correlationKey: input.prompt });
  }
  return out;
};
const flow: RegisteredFlow = {
  definition: flow$({
    id: "r12",
    name: "r12",
    version: "1.0.0",
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ reply: z.string() }),
    steps: [echoStep],
  }),
  runner: runner as FlowRunner<unknown, unknown>,
};
const runtime = () => {
  const rt = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  rt.registerFlow(flow.definition, flow.runner);
  return rt;
};
const card = { name: "G", version: "1.0.0", capabilities: {}, skills: [] };
const task = (id: string, text = "hi"): A2ATask => ({
  id,
  message: { role: "user", parts: [{ type: "text", text }] },
});
const PRINCIPALS: Record<string, { actor: string; tenant: string }> = {
  "Bearer alice": { actor: "alice", tenant: "t1" },
  "Bearer bob": { actor: "bob", tenant: "t1" },
};
const authenticate: A2AServerOptions["authenticate"] = (req) =>
  PRINCIPALS[req.headers.authorization ?? ""];
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("R12 — A2A server is secure by default", () => {
  let server: A2AServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  const send = (url: string, who: string | undefined, t: A2ATask) =>
    fetch(`${url}/tasks/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(who !== undefined && { authorization: who }),
      },
      body: JSON.stringify(t),
    });
  const get = (url: string, who: string | undefined, id: string) =>
    fetch(`${url}/tasks/${encodeURIComponent(id)}`, {
      headers: who !== undefined ? { authorization: who } : {},
    });

  it("refuses to be created with no authentication (and no explicit insecure)", () => {
    expect(() => createA2AServer(runtime(), flow, card, { port: 0 })).toThrow(/unauthenticated/);
    expect(() => createA2AServer(runtime(), flow, card)).toThrow(/insecure: true/);
  });

  it("insecure: true is the explicit opt-out and warns loudly", async () => {
    const warnings: string[] = [];
    server = createA2AServer(runtime(), flow, card, {
      port: 0,
      insecure: true,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/insecure: true/);
    await server.start();
    expect((await send(server.url, undefined, task("x"))).status).toBe(202);
  });

  it("an authenticated server does not warn", () => {
    const warnings: string[] = [];
    createA2AServer(runtime(), flow, card, {
      port: 0,
      authenticate,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(0);
  });

  it("strict: insecure is refused; authenticate or resolvePrincipal is required", () => {
    expect(() =>
      createA2AServer(runtime(), flow, card, { port: 0, strict: true, insecure: true })
    ).toThrow(/refused under security.strict/);
    expect(() =>
      createA2AServer(runtime(), flow, card, {
        port: 0,
        strict: true,
        authorize: () => true,
      })
    ).toThrow(/requires `authenticate`/);
    createA2AServer(runtime(), flow, card, { port: 0, strict: true, authenticate });
  });

  it("binds loopback by default — not reachable on another interface", async () => {
    server = createA2AServer(runtime(), flow, card, { port: 0, authenticate });
    await server.start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = new URL(server.url).port;
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i !== undefined && i.family === "IPv4" && !i.internal);
    if (external !== undefined) {
      await expect(
        fetch(`http://${external.address}:${port}/.well-known/agent.json`)
      ).rejects.toThrow();
    }
  });

  it("an explicit host widens the bind", async () => {
    server = createA2AServer(runtime(), flow, card, { port: 0, authenticate, host: "0.0.0.0" });
    await server.start();
    expect(server.url).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it("an unauthenticated request is refused (401) on both task routes; the card stays open", async () => {
    server = createA2AServer(runtime(), flow, card, { port: 0, authenticate });
    await server.start();
    expect((await send(server.url, undefined, task("a"))).status).toBe(401);
    expect((await send(server.url, "Bearer mallory", task("a"))).status).toBe(401);
    expect((await get(server.url, undefined, "a")).status).toBe(401);
    expect((await fetch(`${server.url}/.well-known/agent.json`)).status).toBe(200);
  });

  it("caller B cannot read caller A's task by guessing its id", async () => {
    server = createA2AServer(runtime(), flow, card, { port: 0, authenticate });
    await server.start();
    expect((await send(server.url, "Bearer alice", task("secret-1", "alice data"))).status).toBe(
      202
    );
    await settle();
    const mine = await get(server.url, "Bearer alice", "secret-1");
    expect(mine.status).toBe(200);
    expect(JSON.stringify(await mine.json())).toContain("alice data");
    const theirs = await get(server.url, "Bearer bob", "secret-1");
    expect(theirs.status).toBe(404);
  });

  it("a client-chosen colliding id lands in its own namespace and never touches the victim's task", async () => {
    server = createA2AServer(runtime(), flow, card, { port: 0, authenticate });
    await server.start();
    await send(server.url, "Bearer alice", task("shared-id", "alice data"));
    await settle();
    // Bob submits the SAME id with different content.
    const bobSent = await send(server.url, "Bearer bob", task("shared-id", "bob data"));
    expect(bobSent.status).toBe(202);
    expect(((await bobSent.json()) as { id: string }).id).toBe("shared-id");
    await settle();
    const a = JSON.stringify(await (await get(server.url, "Bearer alice", "shared-id")).json());
    const b = JSON.stringify(await (await get(server.url, "Bearer bob", "shared-id")).json());
    expect(a).toContain("alice data");
    expect(a).not.toContain("bob data");
    expect(b).toContain("bob data");
  });

  it("the client-visible id is never the internal execution id", async () => {
    const rt = runtime();
    const executor = new LoomAgentExecutor(rt, flow, { namespaceByPrincipal: true });
    const alice = { actor: "alice", tenant: "t1" };
    const { id } = await executor.submit(task("t-1"), { principal: alice });
    expect(id).toBe("t-1");
    await settle();
    // The raw runtime has no execution under the bare client id.
    expect(await rt.loadState("t-1")).toBeNull();
    expect(await rt.loadState(`a2a.${principalNamespace(alice)}.t-1`)).not.toBeNull();
  });

  it("caller B cannot continue (provideInput) caller A's suspended task", async () => {
    const rt = runtime();
    const executor = new LoomAgentExecutor(rt, flow, { namespaceByPrincipal: true });
    const alice = { actor: "alice", tenant: "t1" };
    const bob = { actor: "bob", tenant: "t1" };
    await executor.submit(task("w-1", "wait please"), { principal: alice });
    await settle();
    await expect(
      executor.provideInput("w-1", { eventType: "InputProvided", payload: {} }, { principal: bob })
    ).rejects.toThrow();
    await expect(
      executor.provideInput(
        "w-1",
        { eventType: "InputProvided", payload: {} },
        { principal: alice }
      )
    ).resolves.toEqual({ id: "w-1" });
  });

  it("principals differing only by a delegation token share a namespace; tenants do not", () => {
    expect(principalNamespace({ actor: "a", tenant: "t" })).toBe(
      principalNamespace({ actor: "a", tenant: "t", extra: 1 })
    );
    expect(principalNamespace({ actor: "a", tenant: "t1" })).not.toBe(
      principalNamespace({ actor: "a", tenant: "t2" })
    );
  });

  it("with only a boolean `authorize`, authorized callers share ONE namespace (documented)", async () => {
    server = createA2AServer(runtime(), flow, card, {
      port: 0,
      authorize: (req) => req.headers.authorization === "Bearer shared",
    });
    await server.start();
    expect((await send(server.url, undefined, task("z"))).status).toBe(401);
    expect((await send(server.url, "Bearer shared", task("z"))).status).toBe(202);
    await settle();
    expect((await get(server.url, "Bearer shared", "z")).status).toBe(200);
  });
});
