import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { type McpServedTool, type McpServer, createMcpServer } from "./McpServer";

// R12 — the MCP server is untrusted-network ingress: secure by default, per-tool exposure.

let server: McpServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const tool = (name: string): McpServedTool => ({
  name,
  inputSchema: { type: "object" },
  handler: async () => ({ ran: name }),
});
const rpc = (url: string, method: string, params: unknown, auth?: string) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth !== undefined && { authorization: auth }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
const PRINCIPALS: Record<string, { actor: string }> = {
  "Bearer reader": { actor: "reader" },
  "Bearer admin": { actor: "admin" },
};

describe("R12 — MCP server is secure by default", () => {
  it("refuses to be created unauthenticated unless insecure is explicit", () => {
    expect(() => createMcpServer({ port: 0, tools: [tool("a")] })).toThrow(/unauthenticated/);
    expect(() => createMcpServer()).toThrow(/insecure: true/);
  });

  it("insecure: true opts out and warns loudly", async () => {
    const warnings: string[] = [];
    server = createMcpServer({
      port: 0,
      insecure: true,
      warn: (m) => warnings.push(m),
      tools: [tool("a")],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/insecure: true/);
    await server.start();
    expect((await rpc(server.url, "tools/list", {})).status).toBe(200);
  });

  it("strict refuses insecure", () => {
    expect(() => createMcpServer({ port: 0, strict: true, insecure: true })).toThrow(
      /refused under security.strict/
    );
    createMcpServer({ port: 0, strict: true, authorize: () => true });
  });

  it("binds loopback by default", async () => {
    server = createMcpServer({ port: 0, authorize: () => true });
    await server.start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = new URL(server.url).port;
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i !== undefined && i.family === "IPv4" && !i.internal);
    if (external !== undefined) {
      await expect(
        fetch(`http://${external.address}:${port}/`, { method: "POST" })
      ).rejects.toThrow();
    }
  });

  it("authenticate: an unauthenticated request is refused (401)", async () => {
    server = createMcpServer({
      port: 0,
      tools: [tool("a")],
      authenticate: (req) => PRINCIPALS[req.headers.authorization ?? ""],
    });
    await server.start();
    expect((await rpc(server.url, "tools/list", {})).status).toBe(401);
    expect((await rpc(server.url, "tools/list", {}, "Bearer nobody")).status).toBe(401);
    expect((await rpc(server.url, "tools/list", {}, "Bearer reader")).status).toBe(200);
  });

  it("authorizeTool: per-tool exposure — hidden from tools/list and uncallable, reported as unknown", async () => {
    server = createMcpServer({
      port: 0,
      tools: [tool("read"), tool("delete")],
      authenticate: (req) => PRINCIPALS[req.headers.authorization ?? ""],
      authorizeTool: (t, { principal }) => principal?.actor === "admin" || t.name === "read",
    });
    await server.start();
    const names = async (auth: string) =>
      (
        (await (await rpc(server?.url ?? "", "tools/list", {}, auth)).json()) as {
          result: { tools: { name: string }[] };
        }
      ).result.tools.map((t) => t.name);
    expect(await names("Bearer reader")).toEqual(["read"]);
    expect(await names("Bearer admin")).toEqual(["read", "delete"]);

    const denied = (await (
      await rpc(server.url, "tools/call", { name: "delete", arguments: {} }, "Bearer reader")
    ).json()) as { error?: { message: string }; result?: unknown };
    expect(denied.error?.message).toBe("unknown tool: delete");
    expect(denied.result).toBeUndefined();
    const ok = (await (
      await rpc(server.url, "tools/call", { name: "delete", arguments: {} }, "Bearer admin")
    ).json()) as { result: { structuredContent: { ran: string } } };
    expect(ok.result.structuredContent.ran).toBe("delete");
  });

  it("resources tied to a hidden tool's ui:// template are hidden and unreadable too", async () => {
    const ui = (uri: string) => ({ resourceUri: uri });
    server = createMcpServer({
      port: 0,
      tools: [
        { ...tool("read"), ui: ui("ui://read") },
        { ...tool("delete"), ui: ui("ui://delete") },
      ],
      resources: [
        { uri: "ui://read", mimeType: "text/html", text: "r" },
        { uri: "ui://delete", mimeType: "text/html", text: "SECRET" },
        { uri: "doc://plain", text: "p" },
      ],
      authenticate: (req) => PRINCIPALS[req.headers.authorization ?? ""],
      authorizeTool: (t, { principal }) => principal?.actor === "admin" || t.name === "read",
    });
    await server.start();
    const list = async (auth: string) =>
      (
        (await (await rpc(server?.url ?? "", "resources/list", {}, auth)).json()) as {
          result: { resources: { uri: string }[] };
        }
      ).result.resources.map((r) => r.uri);
    expect(await list("Bearer reader")).toEqual(["ui://read", "doc://plain"]);
    expect(await list("Bearer admin")).toEqual(["ui://read", "ui://delete", "doc://plain"]);
    const denied = (await (
      await rpc(server.url, "resources/read", { uri: "ui://delete" }, "Bearer reader")
    ).json()) as { error?: { message: string } };
    expect(denied.error?.message).toBe("unknown resource: ui://delete");
    const ok = await (
      await rpc(server.url, "resources/read", { uri: "ui://delete" }, "Bearer admin")
    ).json();
    expect(JSON.stringify(ok)).toContain("SECRET");
  });

  it("authorizeAppJournaledCall receives the principal", async () => {
    let seen: unknown;
    server = createMcpServer({
      port: 0,
      tools: [
        { ...tool("j"), mode: "journaled", ui: { resourceUri: "ui://j", visibility: ["app"] } },
      ],
      authenticate: (req) => PRINCIPALS[req.headers.authorization ?? ""],
      audienceOf: () => "app",
      authorizeAppJournaledCall: (_t, _req, principal) => {
        seen = principal;
        return true;
      },
    });
    await server.start();
    await rpc(server.url, "tools/call", { name: "j", arguments: {} }, "Bearer admin");
    expect(seen).toEqual({ actor: "admin" });
  });

  it("a strict runtime makes insecure a config error without passing `strict`", () => {
    expect(() =>
      createMcpServer({ port: 0, insecure: true, runtime: { requiresPrincipal: true } })
    ).toThrow(/refused under security.strict/);
    const warnings: string[] = [];
    createMcpServer({
      port: 0,
      insecure: true,
      strict: false,
      runtime: { requiresPrincipal: true },
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
  });
});
