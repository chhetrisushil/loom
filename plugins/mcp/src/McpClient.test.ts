import * as http from "node:http";
import { EffectRuntime } from "@loom/effect-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient, McpToolNamesSkippedError } from "./McpClient";

// A tiny fake MCP server that speaks the subset of JSON-RPC McpClient uses.
function startFakeMcpServer(
  toolNames?: string[]
): Promise<{ url: string; close: () => Promise<void> }> {
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
          tools: (toolNames ?? ["search"]).map((name) => ({
            name,
            description: "Search the web",
            inputSchema: { properties: { q: { type: "string" } } },
          })),
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

  describe("skipped tool names are visible", () => {
    async function client(names: string[]): Promise<McpClient> {
      fake = await startFakeMcpServer(names);
      const c = new McpClient({ transport: "http", url: fake.url });
      await c.connect();
      return c;
    }
    async function captureWarnings<T>(
      fn: () => Promise<T>
    ): Promise<{ out: T; warnings: string[] }> {
      const warnings: string[] = [];
      const listener = (w: Error & { code?: string }) => {
        if (w.code === "LOOM_MCP_TOOL_NAME") warnings.push(w.message);
      };
      process.on("warning", listener);
      try {
        const out = await fn();
        await new Promise((r) => setImmediate(r)); // emitWarning delivers on nextTick, before this
        return { out, warnings };
      } finally {
        process.off("warning", listener);
      }
    }

    it("default: skips, calls onSkippedTool per tool, and warns per tool with the count and anyToolName", async () => {
      const c = await client(["ok_tool", "db.query", "other.tool"]);
      const seen: Array<[string, string]> = [];
      const { out, warnings } = await captureWarnings(() =>
        c.listTools({ onSkippedTool: (n, r) => seen.push([n, r]) })
      );
      expect(out.map((t) => t.definition.id)).toEqual(["ok_tool"]);
      expect(seen.map(([n]) => n)).toEqual(["db.query", "other.tool"]);
      expect(seen[0]?.[1]).toContain("^[A-Za-z0-9_-]{1,64}$");
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("2 tool(s) skipped");
      expect(warnings[0]).toContain("anyToolName");
    });

    it("strictToolNames throws a typed error listing every skipped name", async () => {
      const c = await client(["ok_tool", "db.query", "other.tool"]);
      const err = await c.listTools({ strictToolNames: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpToolNamesSkippedError);
      expect((err as McpToolNamesSkippedError).skipped.map((s) => s.name)).toEqual([
        "db.query",
        "other.tool",
      ]);
      expect((err as Error).message).toContain("db.query");
    });

    it("strictToolNames does not throw when nothing is skipped", async () => {
      const c = await client(["a", "b"]);
      expect(await c.listTools({ strictToolNames: true })).toHaveLength(2);
    });

    it("anyToolName: a dotted name passes", async () => {
      const c = await client(["db.query", "a/b:c"]);
      const { out, warnings } = await captureWarnings(() => c.listTools({ anyToolName: true }));
      expect(out.map((t) => t.definition.id)).toEqual(["db.query", "a/b:c"]);
      expect(warnings).toHaveLength(0);
    });

    it("anyToolName still refuses newline, zero-width, over-256 and empty names, visibly", async () => {
      const c = await client(["db.query", "has\nnewline", "zero\u200Bwidth", "x".repeat(257), ""]);
      const seen: string[] = [];
      const { out, warnings } = await captureWarnings(() =>
        c.listTools({ anyToolName: true, onSkippedTool: (n) => seen.push(n) })
      );
      expect(out.map((t) => t.definition.id)).toEqual(["db.query"]);
      expect(seen).toHaveLength(4);
      expect(warnings).toHaveLength(4);
      expect(warnings[0]).not.toContain("\n");
      expect(warnings[0]).not.toContain("\u200B");
    });

    it("anyToolName refuses a bidi override and a lone surrogate too", async () => {
      const c = await client(["db.query", "evil\u202Eexe", "half\uD800"]);
      const seen: string[] = [];
      const { out } = await captureWarnings(() =>
        c.listTools({ anyToolName: true, onSkippedTool: (n) => seen.push(n) })
      );
      expect(out.map((t) => t.definition.id)).toEqual(["db.query"]);
      expect(seen).toEqual(["evil\u202Eexe", "half\uD800"]);
    });

    it("a throwing onSkippedTool does not abort the listing", async () => {
      const c = await client(["ok_tool", "db.query", "other.tool"]);
      const { out, warnings } = await captureWarnings(() =>
        c.listTools({
          onSkippedTool: () => {
            throw new Error("hook bug");
          },
        })
      );
      expect(out.map((t) => t.definition.id)).toEqual(["ok_tool"]);
      expect(warnings).toHaveLength(2); // every skip still warned about
    });

    it("anyToolName accepts a 256-character name", async () => {
      const c = await client(["x".repeat(256)]);
      expect(await c.listTools({ anyToolName: true })).toHaveLength(1);
    });
  });
});
