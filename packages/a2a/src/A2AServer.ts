import * as http from "node:http";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { LoomAgentExecutor } from "./AgentExecutor";
import type { A2ATask, AgentCard } from "./types";

export interface A2AServerOptions {
  port?: number;
}

export interface A2AServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks);
        resolve(JSON.parse(raw.toString("utf-8")) as unknown);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", (err: Error) => reject(err));
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

export function createA2AServer(
  workflowRuntime: WorkflowRuntime,
  flow: RegisteredFlow,
  agentCard: Omit<AgentCard, "url">,
  options: A2AServerOptions = {}
): A2AServer {
  const port = options.port ?? 3001;
  let resolvedUrl = `http://localhost:${port}`;

  // The whole A2A layer is this one adapter; the server just moves bytes to it.
  const executor = new LoomAgentExecutor(workflowRuntime, flow);

  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse): void => {
    void (async () => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      try {
        if (method === "GET" && url === "/.well-known/agent.json") {
          json(res, 200, { ...agentCard, url: resolvedUrl });
          return;
        }

        if (method === "POST" && url === "/tasks/send") {
          const task = (await parseBody(req)) as A2ATask;
          const { id } = await executor.submit(task);
          json(res, 202, { id });
          return;
        }

        const taskMatch = /^\/tasks\/([^/]+)$/.exec(url);
        if (method === "GET" && taskMatch !== null) {
          const taskId = taskMatch[1];
          if (taskId === undefined) {
            json(res, 400, { error: "missing task id" });
            return;
          }
          const result = await executor.get(taskId);
          if (result === null) {
            json(res, 404, { error: `task ${taskId} not found` });
            return;
          }
          json(res, 200, result);
          return;
        }

        json(res, 404, { error: "not found" });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    })();
  });

  return {
    get url() {
      return resolvedUrl;
    },
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(port, () => {
          const addr = server.address();
          if (addr !== null && typeof addr === "object") {
            resolvedUrl = `http://localhost:${addr.port}`;
          }
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err?: Error) => (err !== undefined ? reject(err) : resolve()));
      });
    },
  };
}
