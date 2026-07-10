import * as http from "node:http";
import type { ExecutionPackage, WorkerRuntime } from "@loom/worker-runtime";

export interface WorkerServerOptions {
  /** Port to listen on. 0 (default) picks a free port — read `.port` after start. */
  port?: number;
}

export interface WorkerServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
  readonly port: number;
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.length === 0 ? {} : (JSON.parse(raw) as unknown));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", (err: Error) => reject(err));
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * The dedicated, STATELESS worker endpoint. It is a thin HTTP adapter over a
 * {@link WorkerRuntime} (borrowing A2AServer's node:http mechanics but keeping
 * NO in-memory execution state — no handle map). Per request it allocates a
 * lease, runs exactly one {@link ExecutionPackage} to suspend-or-complete, and
 * releases — the worker rebuilds all execution state from the shared event +
 * snapshot stores the injected runtime points at.
 *
 *   POST /execute   { "executionPackage": { ... } }  →  ExecutionResult
 *   POST /cancel    { "executionId", "reason"? }     →  { cancelled: boolean }   (K8.5)
 *   GET  /health                                     →  { healthy: true }
 *
 * This is the container entrypoint for Step 3 (Cloud Run): the same process,
 * booted with flows/effects registered, invoked over HTTP.
 */
export function createWorkerServer(
  worker: WorkerRuntime,
  options: WorkerServerOptions = {}
): WorkerServer {
  const requestedPort = options.port ?? 0;
  let resolvedPort = requestedPort;

  const server = http.createServer((req, res): void => {
    void (async () => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";
      try {
        if (method === "GET" && url === "/health") {
          json(res, 200, { healthy: true });
          return;
        }

        if (method === "POST" && url === "/execute") {
          const body = (await parseBody(req)) as { executionPackage?: ExecutionPackage };
          const pkg = body.executionPackage;
          if (!pkg || typeof pkg.executionId !== "string" || typeof pkg.flowId !== "string") {
            json(res, 400, { error: "invalid executionPackage" });
            return;
          }

          const lease = await worker.allocate({
            executionId: pkg.executionId,
            ...(pkg.metadata !== undefined && { metadata: pkg.metadata }),
          });
          try {
            const result = await worker.execute(lease, pkg);
            json(res, 200, result);
          } finally {
            await worker.release(lease);
          }
          return;
        }

        if (method === "POST" && url === "/cancel") {
          // K8.5 — cross-seam cancellation: the orchestrator reaches an
          // execution running on THIS worker. Best-effort by contract; the
          // caller's durable settlement never depends on this request landing.
          const body = (await parseBody(req)) as { executionId?: string; reason?: string };
          if (typeof body.executionId !== "string") {
            json(res, 400, { error: "invalid executionId" });
            return;
          }
          if (worker.cancel === undefined) {
            json(res, 501, { error: "worker does not support cancel" });
            return;
          }
          const cancelled = await worker.cancel(body.executionId, body.reason);
          json(res, 200, { cancelled });
          return;
        }

        json(res, 404, { error: "not found" });
      } catch (err) {
        json(res, 500, { error: String(err instanceof Error ? err.message : err) });
      }
    })();
  });

  return {
    get url() {
      return `http://localhost:${resolvedPort}`;
    },
    get port() {
      return resolvedPort;
    },
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(requestedPort, () => {
          const addr = server.address();
          if (addr !== null && typeof addr === "object") {
            resolvedPort = addr.port;
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
