import * as http from "node:http";
import type { FlowDefinition } from "@loom/core";
import { fnv1a64 } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpClient } from "./McpClient";
import { MCP_UI_OBSERVED, mcpInvoke$, registerMcpInvoke } from "./mcpInvoke$";
import type { McpCallToolResult } from "./types";

// ── ADR 0072 — a UI-bearing result observed THROUGH the registered effect ────
//
// `ingress.test.ts` exercises `McpClient` directly, which is a level no flow
// traverses: every step seam dispatched through `callTool`, the convenience
// projection that resolves to `structuredContent`-or-text and drops `_meta`
// (where `_meta.ui.resourceUri` lives) along with every non-text content block.
// So the ingress layer was fully tested and completely unreachable. These tests
// assert the property that actually matters — a UI-bearing result is observable
// from the LOG — and are written against the effect, never the client.

const CHART_SCHEMA = { type: "object", properties: {}, required: [] };
const UI_URI = "ui://charts/bar";
const UI_BODY = "<html><body>chart</body></html>";

interface FakeServer {
  url: string;
  close: () => Promise<void>;
  methods: string[];
}

interface FakeOptions {
  /** `_meta.ui` on the TOOL (what `tools/list` declares). */
  toolUi?: Record<string, unknown>;
  /** The `tools/call` result this server returns. */
  result: McpCallToolResult;
  /** `resources/read` contents, keyed by URI. Absent URI ⇒ empty contents. */
  resources?: Record<string, { uri: string; mimeType?: string; text?: string }>;
}

function startFakeMcpServer(options: FakeOptions): Promise<FakeServer> {
  const methods: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c: Uint8Array) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        method: string;
        id: number;
        params?: Record<string, unknown>;
      };
      methods.push(body.method);
      let result: unknown;
      if (body.method === "initialize") {
        result = { protocolVersion: "2025-11-25", capabilities: {} };
      } else if (body.method === "tools/list") {
        result = {
          tools: [
            {
              name: "chart",
              description: "Render a chart",
              inputSchema: CHART_SCHEMA,
              ...(options.toolUi !== undefined && { _meta: { ui: options.toolUi } }),
            },
          ],
        };
      } else if (body.method === "tools/call") {
        result = options.result;
      } else if (body.method === "resources/read") {
        const uri = (body.params as { uri?: string } | undefined)?.uri ?? "";
        const contents = options.resources?.[uri];
        result = { contents: contents === undefined ? [] : [contents] };
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
        url: `http://localhost:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        methods,
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

/** Dispatch `chart` through `mcpInvoke$` and return the step output plus the log. */
async function dispatch(
  client: McpClient,
  opts: Parameters<typeof registerMcpInvoke>[2],
  executionId: string
) {
  const eventStore = new InMemoryAsyncEventStore();
  const effectRuntime = new EffectRuntime();
  registerMcpInvoke(client, effectRuntime, { server: "fake", ...opts });
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime,
  });

  const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    const out = await ctx.run(mcpInvoke$("render#0"), { toolName: "chart", args: {} });
    return { out: out as Record<string, unknown> };
  };
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: "ui-flow",
    name: "ui-flow",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [],
  };
  const flow: RegisteredFlow<Record<string, unknown>, Record<string, unknown>> = {
    definition,
    runner,
  };
  runtime.registerFlow(definition, runner);
  const handle = await runtime.start(flow, {}, { executionId });
  // A failed execution REJECTS waitForCompletion; the log is the assertion
  // surface either way.
  const status = await handle
    .waitForCompletion()
    .then((s) => s.status)
    .catch(() => "failed" as const);
  const events = await eventStore.read(executionId);
  const terminal = events.find(
    (e) => e.eventType === "EXECUTION_COMPLETED" || e.eventType === "EXECUTION_FAILED"
  );
  const payload = terminal?.payload as { output?: unknown; error?: string } | undefined;
  return {
    status,
    output: payload?.output,
    error: payload?.error,
    events,
    observed: events.filter((e) => e.eventType === MCP_UI_OBSERVED).map((e) => e.payload),
  };
}

describe("MCP Apps ingress, through the effect (ADR 0072)", () => {
  it("resultFidelity:'full' keeps _meta and non-text blocks that the default projection drops", async () => {
    const result: McpCallToolResult = {
      content: [
        { type: "text", text: "a bar chart" },
        { type: "resource", resource: { uri: UI_URI, mimeType: "text/html", text: UI_BODY } },
      ],
      structuredContent: { bars: [1, 2] },
      _meta: { ui: { resourceUri: UI_URI } },
    };
    fake = await startFakeMcpServer({ result });
    const client = new McpClient({ transport: "http", url: fake.url });

    const flat = await dispatch(client, {}, "ui-flat");
    // The default projection is unchanged — structuredContent wins, everything else is gone.
    expect(flat.output).toEqual({ out: { bars: [1, 2] } });

    const full = await dispatch(client, { resultFidelity: "full" }, "ui-full");
    const out = (full.output as { out: McpCallToolResult }).out;
    expect(out._meta).toEqual({ ui: { resourceUri: UI_URI } });
    expect(out.content).toHaveLength(2);
    expect(out.content[1]?.resource?.text).toBe(UI_BODY);
    expect(out.structuredContent).toEqual({ bars: [1, 2] });
  });

  it("an in-band isError still throws under full fidelity", async () => {
    fake = await startFakeMcpServer({
      result: { content: [{ type: "text", text: "rate limited" }], isError: true },
    });
    const client = new McpClient({ transport: "http", url: fake.url });
    const run = await dispatch(client, { resultFidelity: "full" }, "ui-err");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/rate limited/);
  });

  it("an embedded ui:// resource is pinned for free — no extra resources/read", async () => {
    fake = await startFakeMcpServer({
      result: {
        content: [
          { type: "resource", resource: { uri: UI_URI, mimeType: "text/html", text: UI_BODY } },
        ],
        structuredContent: { ok: true },
      },
    });
    const client = new McpClient({ transport: "http", url: fake.url });
    const run = await dispatch(client, {}, "ui-embedded");

    expect(run.observed).toEqual([
      {
        toolName: "chart",
        resourceUri: UI_URI,
        contentHash: `fnv1a64:${fnv1a64(`text:${UI_BODY}`)}`,
        pin: "embedded",
      },
    ]);
    expect(fake.methods).not.toContain("resources/read");
  });

  it("a declared-but-not-embedded UI is recorded unpinned unless resolveUi is set", async () => {
    const makeServer = () =>
      startFakeMcpServer({
        toolUi: { resourceUri: UI_URI, visibility: ["model", "app"] },
        result: { content: [{ type: "text", text: "{}" }], structuredContent: { ok: true } },
        resources: { [UI_URI]: { uri: UI_URI, mimeType: "text/html", text: UI_BODY } },
      });

    fake = await makeServer();
    const lazy = await dispatch(
      new McpClient({ transport: "http", url: fake.url }),
      {},
      "ui-declared"
    );
    expect(lazy.observed).toEqual([
      { toolName: "chart", resourceUri: UI_URI, pin: "not-requested" },
    ]);
    expect(fake.methods).not.toContain("resources/read");
    await fake.close();

    fake = await makeServer();
    const resolved = await dispatch(
      new McpClient({ transport: "http", url: fake.url }),
      { resolveUi: true },
      "ui-resolved"
    );
    expect(resolved.observed).toEqual([
      {
        toolName: "chart",
        resourceUri: UI_URI,
        contentHash: `fnv1a64:${fnv1a64(`text:${UI_BODY}`)}`,
        pin: "resolved",
      },
    ]);
    expect(fake.methods).toContain("resources/read");
  });

  it("a resource the server cannot produce is 'unresolvable', not a failed dispatch", async () => {
    fake = await startFakeMcpServer({
      toolUi: { resourceUri: UI_URI },
      result: { content: [{ type: "text", text: "{}" }], structuredContent: { ok: true } },
      // No `resources` entry — `resources/read` returns empty contents.
    });
    const client = new McpClient({ transport: "http", url: fake.url });
    const run = await dispatch(client, { resolveUi: true }, "ui-unresolvable");

    // The tool call SUCCEEDED and its side effect happened; a missing template
    // must not retroactively fail it. The gap is recorded, not swallowed.
    expect(run.status).toBe("completed");
    expect(run.observed).toEqual([{ toolName: "chart", resourceUri: UI_URI, pin: "unresolvable" }]);
  });

  it("a tool with no UI emits nothing — no false positives", async () => {
    fake = await startFakeMcpServer({
      result: { content: [{ type: "text", text: "{}" }], structuredContent: { ok: true } },
    });
    const client = new McpClient({ transport: "http", url: fake.url });
    const run = await dispatch(client, { resolveUi: true }, "ui-none");
    expect(run.observed).toEqual([]);
    expect(fake.methods).not.toContain("resources/read");
  });
});
