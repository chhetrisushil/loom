import * as http from "node:http";
import { EffectRuntime, GrantTable } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "./McpClient";
import { mcpToolCapability, registerMcpInvoke } from "./mcpInvoke$";
import { MCP_INVOKE_TOOL_ID } from "./mcpInvoke$";

// R12 — per-tool authorization on the CLIENT side (loom calling remote MCP tools): ONE registered
// effect (`mcp.invoke`) fronts every tool, so the authorizer is handed `<server>/<tool>` as the
// resource and a grant can name individual tools.

let fake: http.Server | undefined;
let calls: string[] = [];
afterEach(async () => {
  await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
  fake = undefined;
  calls = [];
});

async function startFake(): Promise<string> {
  fake = http.createServer((req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c: Uint8Array) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        method: string;
        id: number;
        params?: { name?: string };
      };
      let result: unknown;
      if (body.method === "initialize")
        result = { protocolVersion: "2024-11-05", capabilities: {} };
      else if (body.method === "tools/list") {
        const schema = { type: "object", properties: {} };
        result = {
          tools: ["read_doc", "delete_doc"].map((name) => ({ name, inputSchema: schema })),
        };
      } else if (body.method === "tools/call") {
        calls.push(body.params?.name ?? "?");
        result = { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((r) => fake?.listen(0, "127.0.0.1", () => r()));
  const addr = fake.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
}

const ctx: EffectContext = {
  executionId: "e",
  stepId: "s",
  workflowId: "flow",
  attempt: 1,
  emit: vi.fn(),
};

async function rig(grants: string[]) {
  const url = await startFake();
  const rt = new EffectRuntime([], { authorizer: new GrantTable({ flow: grants }) });
  registerMcpInvoke(new McpClient({ transport: "http", url }), rt, { server: "docs" });
  const call = (toolName: string) => rt.execute(MCP_INVOKE_TOOL_ID, { toolName, args: {} }, ctx);
  return { call };
}

describe("MCP per-tool authorization (R12)", () => {
  it("names the capability mcp.invoke:<server>/<tool>", () => {
    expect(mcpToolCapability("docs", "read_doc")).toBe("mcp.invoke:docs/read_doc");
  });

  it("a per-tool grant allows only that tool and denies another on the same server", async () => {
    const { call } = await rig([mcpToolCapability("docs", "read_doc")]);
    await expect(call("read_doc")).resolves.toEqual({ ok: true });
    await expect(call("delete_doc")).rejects.toMatchObject({ name: "CapabilityDeniedError" });
    expect(calls).toEqual(["read_doc"]); // the denied tool never reached the server
  });

  it("a per-tool grant names the SERVER too: the same tool on another server is not granted", async () => {
    const { call } = await rig([mcpToolCapability("other-server", "read_doc")]);
    await expect(call("read_doc")).rejects.toMatchObject({ name: "CapabilityDeniedError" });
    expect(calls).toEqual([]);
  });

  it("the legacy `mcp.invoke` grant still allows every tool (documented coarse grant)", async () => {
    const { call } = await rig([MCP_INVOKE_TOOL_ID]);
    await expect(call("read_doc")).resolves.toEqual({ ok: true });
    await expect(call("delete_doc")).resolves.toEqual({ ok: true });
  });

  it("no grant at all denies everything", async () => {
    const { call } = await rig(["something-else"]);
    await expect(call("read_doc")).rejects.toMatchObject({ name: "CapabilityDeniedError" });
  });
});

describe("MCP server identity for grants (R12 review)", () => {
  it('defaults `server` to the client URL\'s hostname (stable identity), not the literal "server"', async () => {
    const url = await startFake();
    const hostId = new McpClient({ transport: "http", url }).serverHost;
    expect(hostId).toMatch(/^127\.0\.0\.1_\d+$/);
    const rt = new EffectRuntime([], {
      authorizer: new GrantTable({ flow: [`mcp.invoke:${hostId}/read_doc`] }),
    });
    registerMcpInvoke(new McpClient({ transport: "http", url }), rt);
    const call = (toolName: string) => rt.execute(MCP_INVOKE_TOOL_ID, { toolName, args: {} }, ctx);
    await expect(call("read_doc")).resolves.toEqual({ ok: true });
    await expect(call("delete_doc")).rejects.toMatchObject({ name: "CapabilityDeniedError" });
  });

  it("serverHost keeps a non-default port so two ports on one host get distinct ids (round 2)", () => {
    const id = (url: string) => new McpClient({ transport: "http", url }).serverHost;
    expect(id("http://localhost:3001/mcp")).toBe("localhost_3001");
    expect(id("http://localhost:3002/mcp")).toBe("localhost_3002");
    expect(id("http://localhost/mcp")).toBe("localhost");
    expect(id("http://example.com:80/mcp")).toBe("example.com");
    expect(id("https://example.com:443/mcp")).toBe("example.com");
    expect(id("http://[::1]:3001/mcp")).toBe("__1_3001");
  });

  it("rejects a `server` label containing '/' or ':' (the <server>/<tool> id would be ambiguous)", () => {
    const rt = new EffectRuntime();
    const client = new McpClient({ transport: "http", url: "http://127.0.0.1:1" });
    expect(() => registerMcpInvoke(client, rt, { server: "a/b" })).toThrow(/server/);
    expect(() => registerMcpInvoke(client, rt, { server: "a:b" })).toThrow(/server/);
  });
});
