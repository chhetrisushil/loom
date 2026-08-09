import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { BadRequestError, exposeError } from "@loom/core";
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
  /**
   * Called with the real error behind a 500, alongside the `errorId` the caller was given.
   * The response itself carries no internal detail, so this is the only place it surfaces —
   * wire it to your logger or the detail is simply lost.
   */
  onError?: (errorId: string, err: unknown) => void;
}

export interface A2AServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}

// Cap request bodies so an unauthenticated caller can't OOM the process by streaming a
// huge (or endless) body into memory before parse. Matches the isolate broker's 10 MB cap.
const MAX_BODY_BYTES = 10 * 1024 * 1024;
// `task.id` becomes the executionId, which is embedded in event ids and carried in the
// Postgres NOTIFY payload (itself capped at ~8 KB). Generous for a ULID or a UUID.
const MAX_TASK_ID_LENGTH = 200;

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on("data", (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new BadRequestError(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks);
        resolve(JSON.parse(raw.toString("utf-8")) as unknown);
      } catch {
        // The caller's own malformed JSON — safe to name, and useless to hide.
        reject(new BadRequestError("request body is not valid JSON"));
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
          // `task.id` becomes the executionId VERBATIM, so it is screened here rather than
          // only deep in the kernel — a rejected id should read as a 400 from the adapter,
          // not surface as a 500 from the runtime.
          if (typeof task?.id !== "string" || task.id.length === 0) {
            json(res, 400, { error: "task.id must be a non-empty string" });
            return;
          }
          // The kernel reserves `__loom_*` for its own control streams (retention lifecycle,
          // erasure). An execution created there both corrupts that audit trail and becomes
          // invisible to every enumerator, so retention never reclaims it.
          if (task.id.startsWith("__loom_")) {
            json(res, 400, { error: 'task.id must not use the reserved "__loom_" prefix' });
            return;
          }
          // Bound it: the id is embedded in every event id and travels in the Postgres
          // NOTIFY payload, which is itself capped — an unbounded id turns into failing
          // appends rather than a rejected request.
          if (task.id.length > MAX_TASK_ID_LENGTH) {
            json(res, 400, { error: `task.id exceeds ${MAX_TASK_ID_LENGTH} characters` });
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
        const exposed = exposeError(err, randomUUID);
        if (exposed.internal !== undefined) {
          options.onError?.(exposed.body.errorId as string, exposed.internal);
        }
        json(res, exposed.status, exposed.body);
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
