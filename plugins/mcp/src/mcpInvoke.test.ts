import * as http from "node:http";
import type { FlowDefinition } from "@loom/core";
import { TypedFailure, jsonSchemaHash } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { redactionMiddleware, secretRef } from "@loom/middleware";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpClient } from "./McpClient";
import { MCP_DISPATCHED, mcpDispatchIndex, mcpInvoke$, registerMcpInvoke } from "./mcpInvoke$";

// ── ADR 0063 — mcpInvoke$ end-to-end against a fake MCP server ───────────────

const SEARCH_SCHEMA = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};

interface FakeServer {
  url: string;
  close: () => Promise<void>;
  requests: { method: string; authorization?: string }[];
  /** Mutate to simulate backend schema drift. */
  setSchema: (schema: Record<string, unknown>) => void;
}

function startFakeMcpServer(): Promise<FakeServer> {
  let schema: Record<string, unknown> = SEARCH_SCHEMA;
  const requests: FakeServer["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c: Uint8Array) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        method: string;
        id: number;
        params?: Record<string, unknown>;
      };
      requests.push({
        method: body.method,
        ...(req.headers.authorization !== undefined && {
          authorization: req.headers.authorization,
        }),
      });
      let result: unknown;
      if (body.method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: {} };
      } else if (body.method === "tools/list") {
        result = { tools: [{ name: "search", description: "Search", inputSchema: schema }] };
      } else if (body.method === "tools/call") {
        const args = body.params?.arguments as { q?: string };
        result = { content: [{ type: "text", text: JSON.stringify({ hits: [args?.q] }) }] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        requests,
        setSchema: (s) => {
          schema = s;
        },
      });
    });
  });
}

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;

function makeFlow(
  runner: FlowRunner<Record<string, unknown>, Record<string, unknown>>
): RegisteredFlow<Record<string, unknown>, Record<string, unknown>> {
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: "mcp-flow",
    name: "mcp-flow",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [],
  };
  return { definition, runner };
}

function boot(client: McpClient, opts?: Parameters<typeof registerMcpInvoke>[2]) {
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const effectRuntime = new EffectRuntime([
    redactionMiddleware({
      resolver: { resolve: async (refId) => (refId === "recipient" ? "raw-token-123" : null) },
    }),
  ]);
  // acceptResolvedTokens: redactionMiddleware IS wired above, so a string
  // reaching the effect is a resolved secretRef (the SEC-1 assertion).
  registerMcpInvoke(client, effectRuntime, {
    server: "fake",
    acceptResolvedTokens: true,
    ...opts,
  });
  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
  return { runtime, eventStore, snapshotStore };
}

describe("mcpInvoke$ (ADR 0063)", () => {
  it("schemaHash is the canonical core hash and is key-order stable", async () => {
    fake = await startFakeMcpServer();
    const client = new McpClient({ transport: "http", url: fake.url });
    const [tool] = await client.listTools();
    expect(tool?.schemaHash).toBe(jsonSchemaHash(SEARCH_SCHEMA));
    expect(tool?.schemaHash).toBe(
      jsonSchemaHash({
        required: ["q"],
        properties: { q: { type: "string" } },
        type: "object",
      })
    );
  });

  it("dispatches with a matching pin, emits MCP_DISPATCHED, and the index projection answers the repair query", async () => {
    fake = await startFakeMcpServer();
    const client = new McpClient({ transport: "http", url: fake.url });
    const pin = jsonSchemaHash(SEARCH_SCHEMA);
    const { runtime, eventStore } = boot(client);

    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      const out = await ctx.run(mcpInvoke$("hydrate#0"), {
        toolName: "search",
        args: { q: "widgets" },
        expectedSchemaHash: pin,
      });
      return { out };
    };
    const flow = makeFlow(runner);
    runtime.registerFlow(flow.definition, runner);
    const handle = await runtime.start(flow, {}, { executionId: "mcp-1" });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    const events = await eventStore.read("mcp-1");
    const dispatched = events.filter((e) => e.eventType === MCP_DISPATCHED);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.payload).toEqual({ toolName: "search", schemaHash: pin, server: "fake" });

    // The proactive-repair query, via the shipped projection — not log parsing.
    const handlers = mcpDispatchIndex.handlers as Record<
      string,
      (s: unknown, e: unknown) => unknown
    >;
    let indexState: unknown = mcpDispatchIndex.initialState;
    for (const e of events) {
      const h = handlers[e.eventType];
      if (h !== undefined) indexState = h(indexState, e);
    }
    expect(indexState).toEqual({
      byTool: {
        search: {
          executions: ["mcp-1"],
          schemaHashes: [pin],
          seen: { "x:mcp-1": true, [`h:${pin}`]: true },
        },
      },
    });
  });

  it("drift: fails typed with observedHash, and replay substitutes with ZERO backend traffic", async () => {
    fake = await startFakeMcpServer();
    const client = new McpClient({ transport: "http", url: fake.url });
    const stalePin = jsonSchemaHash({ ...SEARCH_SCHEMA, properties: { q: { type: "number" } } });
    const observed = jsonSchemaHash(SEARCH_SCHEMA);
    const stores = boot(client);

    const seen: unknown[] = [];
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      try {
        await ctx.run(mcpInvoke$("hydrate#0"), {
          toolName: "search",
          args: { q: "widgets" },
          expectedSchemaHash: stalePin,
        });
        return { branch: "success" };
      } catch (err) {
        if (err instanceof TypedFailure && err.channel === "schemaDrift") {
          seen.push(err.payload);
          await (ctx.suspend({ on: "RepairDone" }) as Promise<unknown>);
          return { branch: "repaired" };
        }
        throw err;
      }
    };
    const flow = makeFlow(runner);
    stores.runtime.registerFlow(flow.definition, runner);
    const started = await stores.runtime.start(flow, {}, { executionId: "mcp-2" });
    await started.waitForSuspend();
    expect(seen).toEqual([
      { toolName: "search", expectedSchemaHash: stalePin, observedHash: observed },
    ]);

    // Resume on a FRESH runtime pointed at a DEAD server: replay must
    // substitute the recorded drift without any listTools/call traffic.
    const deadClient = new McpClient({ transport: "http", url: "http://127.0.0.1:1" });
    const second = boot(deadClient);
    // Reuse the same stores (the durable log).
    const runtime2 = new WorkflowRuntime({
      eventStore: stores.eventStore,
      snapshotStore: stores.snapshotStore,
      effectRuntime: (() => {
        const er = new EffectRuntime();
        registerMcpInvoke(deadClient, er, { server: "fake" });
        return er;
      })(),
    });
    void second;
    runtime2.registerFlow(flow.definition, runner);
    seen.length = 0;
    const done = await runtime2.resume("mcp-2", { eventType: "RepairDone", payload: {} });
    const state = await done.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(seen).toEqual([
      { toolName: "search", expectedSchemaHash: stalePin, observedHash: observed },
    ]); // same branch, same payload — and the dead server proves zero re-invocation
  });

  it("unknown tool fails on the toolNotFound channel", async () => {
    fake = await startFakeMcpServer();
    const client = new McpClient({ transport: "http", url: fake.url });
    const { runtime } = boot(client);
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      try {
        await ctx.run(mcpInvoke$("hydrate#0"), { toolName: "nope" });
        return { branch: "success" };
      } catch (err) {
        if (err instanceof TypedFailure) return { branch: err.channel, payload: err.payload };
        throw err;
      }
    };
    const flow = makeFlow(runner);
    runtime.registerFlow(flow.definition, runner);
    const handle = await runtime.start(flow, {}, { executionId: "mcp-3" });
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(state.frames["hydrate#0"]).toMatchObject({
      status: "failed",
      errorChannel: "toolNotFound",
      errorPayload: { toolName: "nope" },
    });
  });

  it("SEC-1: a string authToken is rejected loudly unless acceptResolvedTokens is asserted", async () => {
    fake = await startFakeMcpServer();
    const client = new McpClient({ transport: "http", url: fake.url });
    // No redaction middleware, no opt-in — the safe default.
    const effectRuntime = new EffectRuntime();
    registerMcpInvoke(client, effectRuntime, { server: "fake" });
    await expect(
      effectRuntime.execute(
        "mcp.invoke",
        { toolName: "search", args: { q: "x" }, authToken: "sk-live-raw-credential" },
        { executionId: "x", stepId: "s", workflowId: "w", attempt: 1, emit: () => {} }
      )
    ).rejects.toThrow(/string authToken rejected/);
    // And an UNRESOLVED secretRef reaching the effect means middleware is missing.
    await expect(
      effectRuntime.execute(
        "mcp.invoke",
        { toolName: "search", authToken: { __loomSecret: "recipient" } },
        { executionId: "x", stepId: "s", workflowId: "w", attempt: 1, emit: () => {} }
      )
    ).rejects.toThrow(/was not resolved/);
    // No tools/call ever went out.
    expect(fake.requests.filter((r) => r.method === "tools/call")).toHaveLength(0);
  });

  it("principal: the recipient token reaches the transport as a header but NEVER the log", async () => {
    fake = await startFakeMcpServer();
    const client = new McpClient({ transport: "http", url: fake.url });
    const pin = jsonSchemaHash(SEARCH_SCHEMA);
    const { runtime, eventStore } = boot(client);

    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      const out = await ctx.run(mcpInvoke$("hydrate#0"), {
        toolName: "search",
        args: { q: "widgets" },
        expectedSchemaHash: pin,
        // The LOGGED input carries only this reference (K10.3); the middleware
        // resolves it to the raw token inside the effect.
        authToken: secretRef("recipient"),
      });
      return { out };
    };
    const flow = makeFlow(runner);
    runtime.registerFlow(flow.definition, runner);
    const handle = await runtime.start(flow, {}, { executionId: "mcp-4" });
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");

    // Transport saw the raw bearer token…
    const call = fake.requests.find((r) => r.method === "tools/call");
    expect(call?.authorization).toBe("Bearer raw-token-123");
    // …the durable log never did, in any event.
    const events = await eventStore.read("mcp-4");
    expect(JSON.stringify(events)).not.toContain("raw-token-123");
    expect(JSON.stringify(events)).toContain("__loomSecret"); // the reference is what's recorded
  });
});
