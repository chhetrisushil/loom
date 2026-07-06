import type { WorkerRuntime } from "@loom/worker-runtime";
import { createWorkerServer } from "./createWorkerServer";
import type { WorkerServer } from "./createWorkerServer";

export interface StartWorkerServerOptions {
  /** Overrides the port. Defaults to `process.env.PORT` (Cloud Run sets it), else 8080. */
  port?: number;
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
  const server = createWorkerServer(worker, { port });
  await server.start();
  return server;
}
