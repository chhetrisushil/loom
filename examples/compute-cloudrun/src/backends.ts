import { LocalDispatcher } from "@loom/dispatcher";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import {
  CloudRunWorkerRuntime,
  StaticCloudRunPlatform,
  defaultSizingPolicy,
} from "@loom/platform-cloudrun";
import type { CloudRunConfig } from "@loom/platform-cloudrun";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { RemoteWorkerRuntime } from "@loom/worker-runtime-remote";
import type { WorkflowRuntime } from "@loom/workflow-runtime";

// Three interchangeable compute backends for the SAME flow. Each returns an
// ExecutionDispatcher; the caller dispatches identical ExecutionPackages and gets
// equivalent ExecutionResults. Only the WorkerRuntime differs — that's the seam.

/** Backend 1 — in-process: run in this very process. */
export function inProcessDispatcher(runtime: WorkflowRuntime): ExecutionDispatcher {
  return new LocalDispatcher(new LocalWorkerRuntime(runtime));
}

/** Backend 2 — remote HTTP: POST ExecutionPackages to a worker server. */
export function remoteDispatcher(workerUrl: string): ExecutionDispatcher {
  return new LocalDispatcher(new RemoteWorkerRuntime(workerUrl));
}

/** Observability captured from the Cloud Run platform (proves the path was taken). */
export interface CloudRunSink {
  logs: Array<Record<string, unknown>>;
  sizings: CloudRunConfig[];
}
export function newCloudRunSink(): CloudRunSink {
  return { logs: [], sizings: [] };
}

/**
 * Backend 3 — Cloud Run: `CloudRunWorkerRuntime` asks the platform to resolve an
 * endpoint (by sizing), then POSTs the ExecutionPackage to it exactly like the
 * remote backend. `StaticCloudRunPlatform(workerUrl)` points that endpoint at our
 * local worker server, so the whole Cloud Run code path runs OFFLINE (no GCP). Swap
 * in a real `CloudRunPlatform` (deploy/reuse a revision) and nothing else changes.
 */
export function cloudRunDispatcher(workerUrl: string, sink: CloudRunSink): ExecutionDispatcher {
  const platform = new StaticCloudRunPlatform(workerUrl, {
    logs: { log: (entry) => sink.logs.push(entry) },
    metrics: { record: () => {} },
  });
  // Wrap the default policy so we can observe how dispatch hints map to a machine size.
  const sizing = (meta?: Parameters<typeof defaultSizingPolicy>[0]): CloudRunConfig => {
    const config = defaultSizingPolicy(meta);
    sink.sizings.push(config);
    return config;
  };
  return new LocalDispatcher(new CloudRunWorkerRuntime(platform, { sizing }));
}
