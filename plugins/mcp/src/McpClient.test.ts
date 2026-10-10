import * as http from "node:http";
import { EffectRuntime } from "@loom/effect-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "./McpClient";

// A tiny fake MCP server that speaks the subset of JSON-RPC McpClient uses.
function startFakeMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c: Uint8Array) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        method: string;
        id: number;
        params?: Record<string, unknown>;
      };
      let result: unknown;
      if (body.method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: {} };
      } else if (body.method === "tools/list") {
        result = {
          tools: [
            {
              name: "search",
              description: "Search the web",
              inputSchema: { properties: { q: { type: "string" } } },
            },
          ],
        };
      } else if (body.method === "tools/call") {
        const args = body.params?.arguments as { q?: string };
        result = {
          content: [{ type: "text", text: JSON.stringify({ hits: [`result for ${args.q}`] }) }],
        };
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });

  return new Promise((resolve) => {
    // Bind the address the client dials. A wildcard `listen(0)` can be handed a port another
    // process holds on 127.0.0.1 (macOS), and the fetch below would reach THAT server.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let fake: { url: string; close: () => Promise<void> } | undefined;

afterEach(async () => {
  if (fake) {
    await fake.close();
    fake = undefined;
  }
});

describe("McpClient", () => {
  it("lists tools and maps them to ToolDefinitions", async () => {
    fake = await startFakeMcpServer();
    const client = new McpClient({ transport: "http", url: fake.url });
    await client.connect();
    const tools = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]?.definition.id).toBe("search");
    expect(tools[0]?.jsonInputSchema).toEqual({ properties: { q: { type: "string" } } });
  });

  it("registers MCP tools into an EffectRuntime", async () => {
    fake = await startFakeMcpServer();
    const client = new McpClient({ transport: "http", url: fake.url });
    await client.connect();

    const effectRuntime = new EffectRuntime();
    const defs = await client.registerInto(effectRuntime);

    expect(defs.map((d) => d.id)).toEqual(["search"]);
    expect(effectRuntime.has("search")).toBe(true);
  });

  it("calls a tool and parses the JSON text result", async () => {
    fake = await startFakeMcpServer();
    const client = new McpClient({ transport: "http", url: fake.url });
    await client.connect();

    const result = (await client.callTool("search", { q: "loom" })) as { hits: string[] };
    expect(result.hits).toEqual(["result for loom"]);
  });
});
