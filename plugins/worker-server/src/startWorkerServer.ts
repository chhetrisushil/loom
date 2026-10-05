import type { WorkerRuntime } from "@loom/worker-runtime";
import { createWorkerServer } from "./createWorkerServer";
import type { WorkerServer, WorkerServerOptions } from "./createWorkerServer";

export interface StartWorkerServerOptions {
  /** Overrides the port. Defaults to `process.env.PORT` (Cloud Run sets it), else 8080. */
  port?: number;
  /**
   * The interface to bind. Defaults to `process.env.HOST`, else `"0.0.0.0"` — this is the
   * container entrypoint and Cloud Run reaches it over the network. Set `authorize` (or front it
   * with IAM) when it is internet-reachable.
   * (`createWorkerServer` itself defaults to loopback.)
   */
  host?: string;
  /** Passed to `createWorkerServer` — gate every non-health route (required for a `runsAsSystem` worker). */
  authorize?: WorkerServerOptions["authorize"];
}

/**
 * Container entrypoint helper. Cloud Run injects `PORT` and expects the process
 * to listen on it; this reads that convention and starts the stateless worker.
 * The caller boots the `WorkerRuntime` (i.e. registers flows/effects on the
 * underlying WorkflowRuntime) before calling this — that is the "code bundle"
 * baked into the container image.
 */
export async function startWorkerServer(
  worker: WorkerRuntime,
  options: StartWorkerServerOptions = {}
): Promise<WorkerServer> {
  const envPort = process.env.PORT;
  const port = options.port ?? (envPort ? Number.parseInt(envPort, 10) : 8080);
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const server = createWorkerServer(worker, {
    port,
    host,
    ...(options.authorize !== undefined ? { authorize: options.authorize } : {}),
  });
  await server.start();
  return server;
}
