import * as http from "http";

// A tiny in-process MCP server so the showcase can connect to MCP without any
// external process. It speaks the subset of the JSON-RPC MCP protocol that
// @loom/mcp's McpClient uses: initialize, tools/list, tools/call.
export function startFakeMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c: Uint8Array) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      // DELETE (disconnect) and other empty-body requests: just ack.
      if (raw.trim() === "") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      const body = JSON.parse(raw) as {
        method: string;
        id: number;
        params?: Record<string, unknown>;
      };

      let result: unknown;
      if (body.method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: { tools: {} } };
      } else if (body.method === "tools/list") {
        result = {
          tools: [
            {
              name: "kb-lookup",
              description: "Look up a runbook entry in the ops knowledge base",
              inputSchema: {
                type: "object",
                properties: { topic: { type: "string" } },
                required: ["topic"],
              },
            },
          ],
        };
      } else if (body.method === "tools/call") {
        const args = body.params?.["arguments"] as { topic?: string };
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                runbook: `RB-204: For "${args.topic}", restart the pod and scale the connection pool.`,
              }),
            },
          ],
        };
      }

      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
