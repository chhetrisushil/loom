import * as http from "node:http";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { LoomAgentExecutor } from "./AgentExecutor";
import type { A2ATask, AgentCard } from "./types";

export interface A2AServerOptions {
  port?: number;
  /**
   * Authenticate the task routes (`POST /tasks/send`, `GET /tasks/:id`). Return `true` to
   * allow. **When unset the server is UNAUTHENTICATED**: any caller can submit tasks and
   * read any execution's folded state. The agent-card route stays open. Supply your own
   * scheme (shared secret, mTLS, …); the server supplies the gate.
   */
  authorize?: (req: http.IncomingMessage) => boolean | Promise<boolean>;
}

export interface A2AServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}

// Cap request bodies so an unauthenticated caller can't OOM the process by streaming a
// huge (or endless) body into memory before parse. Matches the isolate broker's 10 MB cap.
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on("data", (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
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

        // Gate the task routes when an authorizer is wired; the agent card stays open.
        if (options.authorize !== undefined && url !== "/.well-known/agent.json") {
          if (!(await options.authorize(req))) {
            json(res, 401, { error: "unauthorized" });
            return;
          }
        }

        if (method === "POST" && url === "/tasks/send") {
          const task = (await parseBody(req)) as A2ATask;
          // `task.id` becomes the executionId verbatim — reject a non-string so a caller
          // can't squat/collide an execution id with an object/array.
          if (typeof task?.id !== "string" || task.id.length === 0) {
            json(res, 400, { error: "task.id must be a non-empty string" });
            return;
          }
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
