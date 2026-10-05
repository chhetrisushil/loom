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
});
