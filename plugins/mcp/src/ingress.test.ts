import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "./McpClient";
import { DEFAULT_MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_META_KEY } from "./types";
import { isAppVisible, isModelVisible, uiFromResult, uiMetaOf } from "./ui";

// ── ADR 0072 Steps 0 & 1 — ingress fidelity + UI-resource awareness ──────────
//
// Step 0: `callTool` used to filter content to text, join, and JSON.parse it,
// discarding `structuredContent`, `_meta`, every non-text block, and `isError`.
// Step 1: recognise `_meta.ui`, fetch the `ui://` resource, stamp provenance.

interface Recorded {
  method: string;
  params?: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

function startFake(handler: (method: string, params?: Record<string, unknown>) => unknown): {
  ready: Promise<{ url: string; close: () => Promise<void>; seen: Recorded[] }>;
} {
  const seen: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c: Uint8Array) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        method: string;
        id: number;
        params?: Record<string, unknown>;
      };
      seen.push({ method: body.method, params: body.params, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: handler(body.method, body.params) })
      );
    });
  });

  return {
    ready: new Promise((resolve) => {
      // Bind the address the client dials. A wildcard `listen(0)` can be handed a port another
      // process holds on 127.0.0.1 (macOS), and the fetch below would reach THAT server.
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = addr !== null && typeof addr === "object" ? addr.port : 0;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => server.close(() => r())),
          seen,
        });
      });
    }),
  };
}

let fake: { url: string; close: () => Promise<void>; seen: Recorded[] } | undefined;
afterEach(async () => {
  if (fake) {
    await fake.close();
    fake = undefined;
  }
});

describe("Step 0 — tool-result fidelity", () => {
  it("preserves structuredContent, _meta and non-text blocks", async () => {
    fake = await startFake((method) =>
      method === "tools/call"
        ? {
            content: [
              { type: "text", text: "a chart" },
              { type: "image", data: "aGk=", mimeType: "image/png" },
            ],
            structuredContent: { rows: [1, 2, 3] },
            _meta: { ui: { resourceUri: "ui://charts/bar" } },
          }
        : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    const full = await client.callToolResult("chart", {});
    expect(full.structuredContent).toEqual({ rows: [1, 2, 3] });
    expect(full.content).toHaveLength(2);
    // The image block survived — this is exactly what the old flatten destroyed.
    expect(full.content[1]).toMatchObject({ type: "image", data: "aGk=" });
    expect(uiMetaOf(full._meta)?.resourceUri).toBe("ui://charts/bar");
  });

  it("prefers structuredContent over text in the convenience projection", async () => {
    fake = await startFake((method) =>
      method === "tools/call"
        ? { content: [{ type: "text", text: "human summary" }], structuredContent: { n: 7 } }
        : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    expect(await client.callTool("t", {})).toEqual({ n: 7 });
  });

  it("still joins-and-parses text when there is no structuredContent", async () => {
    fake = await startFake((method) =>
      method === "tools/call" ? { content: [{ type: "text", text: '{"hits":["a"]}' }] } : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    expect(await client.callTool("t", {})).toEqual({ hits: ["a"] });
  });

  it("falls back to the raw string for non-JSON text", async () => {
    fake = await startFake((method) =>
      method === "tools/call" ? { content: [{ type: "text", text: "plain words" }] } : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    expect(await client.callTool("t", {})).toBe("plain words");
  });

  // MCP reports tool failures in-band: a SUCCESSFUL JSON-RPC response carrying
  // isError. Returning that as a value turns every tool error into a success.
  it("throws on an in-band isError result instead of returning it as a value", async () => {
    fake = await startFake((method) =>
      method === "tools/call"
        ? { content: [{ type: "text", text: "rate limited" }], isError: true }
        : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    await expect(client.callTool("t", {})).rejects.toThrow(/rate limited/);
    // The full result still exposes it without throwing, for callers that branch.
    expect((await client.callToolResult("t", {})).isError).toBe(true);
  });

  it("tolerates a result with no content array", async () => {
    fake = await startFake((method) =>
      method === "tools/call" ? { structuredContent: { ok: true } } : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    const full = await client.callToolResult("t", {});
    expect(full.content).toEqual([]);
    expect(await client.callTool("t", {})).toEqual({ ok: true });
  });
});

describe("Step 0 — protocol version", () => {
  it("declares the version in the header and _meta, and no longer hardcodes 2024-11-05", async () => {
    fake = await startFake(() => ({})).ready;
    const client = new McpClient({ transport: "http", url: fake.url });
    await client.callToolResult("t", {});

    const req = fake.seen[0];
    expect(req?.headers["mcp-protocol-version"]).toBe(DEFAULT_MCP_PROTOCOL_VERSION);
    expect((req?.params?._meta as Record<string, unknown>)[MCP_PROTOCOL_VERSION_META_KEY]).toBe(
      DEFAULT_MCP_PROTOCOL_VERSION
    );
    expect(DEFAULT_MCP_PROTOCOL_VERSION).not.toBe("2024-11-05");
  });

  it("adopts the server's negotiated version for subsequent requests", async () => {
    fake = await startFake((method) =>
      method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    await client.connect();
    expect(client.protocolVersion).toBe("2025-06-18");

    await client.callToolResult("t", {});
    expect(fake.seen[1]?.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("advertises the UI extension at initialize so a server will send UI tools", async () => {
    fake = await startFake(() => ({ capabilities: {} })).ready;
    const client = new McpClient({ transport: "http", url: fake.url });
    await client.connect();

    const caps = fake.seen[0]?.params?.capabilities as Record<string, unknown>;
    expect(caps.extensions).toHaveProperty("io.modelcontextprotocol/ui");
  });

  it("honours a caller-supplied protocol version", async () => {
    fake = await startFake(() => ({})).ready;
    const client = new McpClient({
      transport: "http",
      url: fake.url,
      protocolVersion: "2026-07-28",
    });
    await client.callToolResult("t", {});

    expect(fake.seen[0]?.headers["mcp-protocol-version"]).toBe("2026-07-28");
  });
});

describe("Step 1 — UI-resource awareness", () => {
  it("surfaces a tool's ui declaration through listTools", async () => {
    fake = await startFake((method) =>
      method === "tools/list"
        ? {
            tools: [
              {
                name: "chart",
                inputSchema: { properties: {} },
                _meta: { ui: { resourceUri: "ui://charts/bar", visibility: ["model", "app"] } },
              },
              { name: "plain", inputSchema: { properties: {} } },
            ],
          }
        : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    const [chart, plain] = await client.listTools();
    expect(chart?.ui?.resourceUri).toBe("ui://charts/bar");
    expect(chart?.ui?.visibility).toEqual(["model", "app"]);
    // A text-only tool carries no `ui` — absence is meaningful, not a default.
    expect(plain?.ui).toBeUndefined();
  });

  it("reads a ui:// resource and stamps it with a content-hash pin", async () => {
    fake = await startFake((method, params) =>
      method === "resources/read"
        ? {
            contents: [
              {
                uri: params?.uri,
                mimeType: "text/html;profile=mcp-app",
                text: "<h1>hi</h1>",
                _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] } } },
              },
            ],
          }
        : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    const res = await client.readUiResource("ui://charts/bar");
    expect(res?.uri).toBe("ui://charts/bar");
    expect(res?.text).toBe("<h1>hi</h1>");
    expect(res?.contentHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(res?.meta?.csp?.connectDomains).toEqual(["https://api.example.com"]);
  });

  // The pin is only worth having if identical markup pins identically and
  // different markup does not — that is what makes replay drift detectable.
  it("pins by content: same body same hash, changed body different hash", async () => {
    let body = "<h1>v1</h1>";
    fake = await startFake((method, params) =>
      method === "resources/read" ? { contents: [{ uri: params?.uri, text: body }] } : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    const first = await client.readUiResource("ui://a");
    const again = await client.readUiResource("ui://a");
    expect(again?.contentHash).toBe(first?.contentHash);

    body = "<h1>v2</h1>";
    const drifted = await client.readUiResource("ui://a");
    expect(drifted?.contentHash).not.toBe(first?.contentHash);
  });

  it("matches the requested URI rather than adopting a neighbouring resource", async () => {
    fake = await startFake((method) =>
      method === "resources/read"
        ? {
            contents: [
              { uri: "ui://other", text: "WRONG" },
              { uri: "ui://wanted", text: "RIGHT" },
            ],
          }
        : {}
    ).ready;
    const client = new McpClient({ transport: "http", url: fake.url });

    expect((await client.readUiResource("ui://wanted"))?.text).toBe("RIGHT");
  });

  it("returns undefined when the server has no contents", async () => {
    fake = await startFake(() => ({ contents: [] })).ready;
    const client = new McpClient({ transport: "http", url: fake.url });
    expect(await client.readUiResource("ui://missing")).toBeUndefined();
  });
});

describe("Step 1 — ui metadata parsing", () => {
  // A `ui` block pointing at an arbitrary scheme is a confused-deputy fetch;
  // refusing it here means no caller can be talked into dereferencing it.
  it("rejects a ui declaration whose resourceUri is not a ui:// URI", () => {
    expect(uiMetaOf({ ui: { resourceUri: "https://evil.example.com/x" } })).toBeUndefined();
    expect(uiMetaOf({ ui: { resourceUri: "file:///etc/passwd" } })).toBeUndefined();
    expect(uiMetaOf({ ui: {} })).toBeUndefined();
    expect(uiMetaOf(undefined)).toBeUndefined();
    expect(uiMetaOf({ ui: { resourceUri: "ui://ok" } })?.resourceUri).toBe("ui://ok");
  });

  // The reference SDK's registerAppTool writes BOTH the nested block and the
  // deprecated flat key, so servers in the wild carry either or both. Reading
  // only the nested one silently misses a UI that is genuinely declared.
  it("accepts the deprecated flat resourceUri key", () => {
    expect(uiMetaOf({ "ui/resourceUri": "ui://legacy/host" })?.resourceUri).toBe(
      "ui://legacy/host"
    );
    expect(uiMetaOf({ ui: { visibility: ["app"] }, "ui/resourceUri": "ui://legacy/host" })).toEqual(
      {
        resourceUri: "ui://legacy/host",
        visibility: ["app"],
      }
    );
    // The nested block still wins when both are present and disagree.
    expect(
      uiMetaOf({ ui: { resourceUri: "ui://new" }, "ui/resourceUri": "ui://old" })?.resourceUri
    ).toBe("ui://new");
    // …and the flat key is held to the same scheme rule as the nested one.
    expect(uiMetaOf({ "ui/resourceUri": "https://evil.example.com/x" })).toBeUndefined();
  });

  it("drops unknown visibility values rather than trusting them", () => {
    const ui = uiMetaOf({ ui: { resourceUri: "ui://a", visibility: ["app", "root", 7] } });
    expect(ui?.visibility).toEqual(["app"]);
  });

  // Undeclared visibility means BOTH audiences per the extension's default — so
  // a serving implementation must declare explicitly rather than rely on it.
  it("treats undeclared visibility as both audiences", () => {
    expect(isAppVisible(undefined)).toBe(true);
    expect(isModelVisible(undefined)).toBe(true);
    expect(isAppVisible({ resourceUri: "ui://a", visibility: ["model"] })).toBe(false);
    expect(isModelVisible({ resourceUri: "ui://a", visibility: ["app"] })).toBe(false);
  });

  it("extracts embedded ui:// resources from a result's content blocks", () => {
    const { meta, embedded } = uiFromResult({
      content: [
        { type: "text", text: "hi" },
        { type: "resource", resource: { uri: "ui://embedded", text: "<b/>" } },
        { type: "resource", resource: { uri: "https://not-ui", text: "x" } },
      ],
      _meta: { ui: { resourceUri: "ui://from-meta" } },
    });
    expect(meta?.resourceUri).toBe("ui://from-meta");
    expect(embedded.map((e) => e.uri)).toEqual(["ui://embedded"]);
  });
});
