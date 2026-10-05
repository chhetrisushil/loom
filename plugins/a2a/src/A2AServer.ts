import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { BadRequestError, exposeError } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { LoomAgentExecutor } from "./AgentExecutor";
import type { A2ATask, AgentCard } from "./types";

export interface A2AServerOptions {
  port?: number;
  /**
   * R12 — the interface to bind. Default `"127.0.0.1"` (loopback only): a server is reachable
   * from this machine and nothing else until you widen it deliberately (`"0.0.0.0"`, `"::"`, or
   * a specific interface address). Binding all interfaces was the old default.
   */
  host?: string;
  /**
   * R12 — authenticate AND identify the caller in one step: return the caller's
   * {@link PrincipalChain}, or `undefined` to refuse the request (401). Derive it from connection
   * facts only (verified bearer token, mTLS peer) — never from the task body. This is the
   * recommended gate: it also scopes task ownership to the principal (see below).
   */
  authenticate?: (
    req: http.IncomingMessage
  ) => PrincipalChain | undefined | Promise<PrincipalChain | undefined>;
  /**
   * Gate the task routes (`POST /tasks/send`, `GET /tasks/:id`). Return `true` to allow. The
   * agent-card route stays open. A boolean carries no identity, so every caller that passes it
   * shares ONE task namespace unless `resolvePrincipal`/`authenticate` says who they are.
   *
   * R12 — the server REFUSES TO BE CREATED with neither `authenticate` nor `authorize` unless
   * {@link insecure} is `true`.
   */
  authorize?: (req: http.IncomingMessage) => boolean | Promise<boolean>;
  /**
   * R12 — explicit opt-out of authentication: any caller that can reach the socket can submit
   * tasks. Logs a loud warning at creation. Intended for local demos and tests; combine with the
   * loopback default. Refused when {@link strict} is set.
   */
  insecure?: boolean;
  /**
   * R12 — pass `app.strict` (`defineConfig`'s `security.strict`). Under strict the server is a
   * config error unless it authenticates AND resolves a principal; `insecure: true` is refused.
   * (The app does not construct this server, so it cannot enforce this for you.)
   */
  strict?: boolean;
  /** Where the insecure-mode warning goes. Default `console.warn`. */
  warn?: (message: string) => void;
  /**
   * R3 — the AUTHENTICATED principal behind a request, derived from the same connection facts
   * `authorize` checked (mTLS peer, verified bearer token, signed header) — NEVER from the task
   * body. Applied to the runtime call for every task route (`/tasks/send`, `GET /tasks/:id`).
   * Without it every task is anonymous, which a runtime that fails closed (`security.strict`)
   * refuses (`ExecutionDeniedError`): an A2A server is an edge, and under strict an edge must
   * say who is calling. Returning `undefined` for a request means "anonymous".
   */
  resolvePrincipal?: (
    req: http.IncomingMessage
  ) => PrincipalChain | undefined | Promise<PrincipalChain | undefined>;
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
  const host = options.host ?? "127.0.0.1";
  const authenticated = options.authenticate !== undefined || options.authorize !== undefined;
  if (options.strict === true) {
    if (options.insecure === true) {
      throw new Error(
        "createA2AServer: `insecure: true` is refused under security.strict — authenticate callers."
      );
    }
    if (options.authenticate === undefined && options.resolvePrincipal === undefined) {
      throw new Error(
        "createA2AServer: security.strict requires `authenticate` (or `resolvePrincipal`) — every task must carry the caller's principal."
      );
    }
  }
  if (!authenticated && options.insecure !== true) {
    throw new Error(
      "createA2AServer: refusing to create an unauthenticated server. Supply `authenticate` (recommended) or `authorize`, or pass `insecure: true` to opt out explicitly."
    );
  }
  if (!authenticated) {
    (options.warn ?? ((m: string) => console.warn(m)))(
      `[loom] WARNING: A2A server is running with insecure: true — NO authentication; any caller that can reach ${host}:${port} can submit and read tasks.`
    );
  }
  const urlHost =
    host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
  let resolvedUrl = `http://${urlHost}:${port}`;

  // The whole A2A layer is this one adapter; the server just moves bytes to it. Task ids are
  // namespaced by principal (R12): the client's id is only a label within its own namespace.
  const executor = new LoomAgentExecutor(workflowRuntime, flow, { namespaceByPrincipal: true });

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

        // R12 — authenticate: identity or refusal.
        let principal: PrincipalChain | undefined;
        if (options.authenticate !== undefined) {
          principal = await options.authenticate(req);
          if (principal === undefined) {
            json(res, 401, { error: "unauthorized" });
            return;
          }
        }
        // R3 — who is calling, resolved once per request, after `authorize`.
        principal ??= await options.resolvePrincipal?.(req);
        // The task namespace: the principal when known; one shared bucket for callers that were
        // authorized but not identified; "anonymous" under `insecure`.
        const call = {
          ...(principal !== undefined && { principal }),
          ...(principal === undefined && authenticated && { namespace: "authorized" }),
        };

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
          const { id } = await executor.submit(task, call);
          json(res, 202, { id });
          return;
        }

        const taskMatch = /^\/tasks\/([^/]+)$/.exec(url);
        if (method === "GET" && taskMatch !== null) {
          const rawTaskId = taskMatch[1];
          if (rawTaskId === undefined) {
            json(res, 400, { error: "missing task id" });
            return;
          }
          // The path segment is percent-encoded on the wire (a client MUST encode an id
          // containing `/` or other reserved characters, or URL normalization upstream of this
          // server — e.g. `fetch`'s own dot-segment collapsing — could otherwise turn an id like
          // `../admin` into a request for a different route entirely). Decode it back to the
          // real task id before it reaches the executor.
          let taskId: string;
          try {
            taskId = decodeURIComponent(rawTaskId);
          } catch {
            json(res, 400, { error: "task id is not validly percent-encoded" });
            return;
          }
          const result = await executor.get(taskId, call);
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
        server.listen(port, host, () => {
          const addr = server.address();
          if (addr !== null && typeof addr === "object") {
            resolvedUrl = `http://${urlHost}:${addr.port}`;
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
