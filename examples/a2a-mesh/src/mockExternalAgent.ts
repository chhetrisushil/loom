import * as http from "node:http";

/**
 * A tiny in-process A2A server that stands in for an external agent framework
 * (Google ADK, LangGraph, CrewAI, …). It speaks the three routes that Loom's
 * A2APeerClient / createA2AClientEffect use:
 *
 *   GET  /.well-known/agent.json   → the AgentCard (discovery)
 *   POST /tasks/send               → accept a task, return { id }
 *   GET  /tasks/:id                → poll for the result
 *
 * In a real deployment this endpoint is your `adk to_a2a(agent)` server, or a
 * thin A2A wrapper in front of a LangGraph/CrewAI graph. Because the wire
 * contract is identical, the Loom side of the mesh is unchanged either way.
 */
export interface MockExternalAgent {
  url: string;
  close: () => Promise<void>;
}

const card = {
  name: "Remote Diagnostics Agent",
  description: "External agent (stands in for ADK/LangGraph) that root-causes incidents",
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "diagnose", name: "Diagnose", description: "Root-cause a failing service from symptoms" },
  ],
};

export function startMockExternalAgent(): Promise<MockExternalAgent> {
  const tasks = new Map<string, { promptText: string }>();
  let counter = 0;

  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const port = addressPort(server);

    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (method === "GET" && url === "/.well-known/agent.json") {
      send(200, { ...card, url: `http://localhost:${port}` });
      return;
    }

    if (method === "POST" && url === "/tasks/send") {
      const chunks: Uint8Array[] = [];
      req.on("data", (c: Uint8Array) => chunks.push(c));
      req.on("end", () => {
        const task = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          message?: { parts?: Array<{ text?: string }> };
        };
        const promptText = (task.message?.parts ?? []).map((p) => p.text ?? "").join("\n");
        const id = `remote-${++counter}`;
        tasks.set(id, { promptText });
        // A2A allows an async task lifecycle; this mock completes immediately and
        // reports the result on the first poll.
        send(202, { id });
      });
      return;
    }

    const match = /^\/tasks\/([^/]+)$/.exec(url);
    if (method === "GET" && match !== null) {
      const id = match[1] ?? "";
      const task = tasks.get(id);
      if (task === undefined) {
        send(404, { error: `task ${id} not found` });
        return;
      }
      // A real ADK/LangGraph agent would run its own reasoning graph here.
      const diagnosis =
        `Diagnosis for "${task.promptText}": connection-pool exhaustion. ` +
        `Recycle the pool and raise its ceiling; scale replicas only if CPU stays high.`;
      send(200, {
        id,
        status: "completed",
        artifacts: [{ parts: [{ type: "text", text: diagnosis }] }],
      });
      return;
    }

    send(404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve({
        url: `http://localhost:${addressPort(server)}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function addressPort(server: http.Server): number {
  const addr = server.address();
  return addr !== null && typeof addr === "object" ? addr.port : 0;
}
