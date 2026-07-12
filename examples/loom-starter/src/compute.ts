import { LocalDispatcher } from "@loom/dispatcher";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import type { WorkflowRuntime } from "@loom/workflow-runtime";

// ── The compute seam ──────────────────────────────────────────────────────────
//
// By default, executions run in-process. A `dispatcher` decides WHERE an
// execution runs, without changing a single flow: an `ExecutionPackage` carries
// resume coordinates (identity + sequence), never code, and the worker resolves
// flows by id from a statically-wired registry.
//
// This helper wraps the local runtime in the same interface a remote / Cloud Run
// dispatcher implements — swap the one line below and the same flows run off-box:
//
//   import { RemoteWorkerRuntime } from "@loom/plugin-worker-remote";
//   return new LocalDispatcher(new RemoteWorkerRuntime("https://worker.example.com"));
//   // …or a Cloud Run dispatcher from @loom/plugin-cloudrun.
export function buildDispatcher(runtime: WorkflowRuntime): ExecutionDispatcher {
  return new LocalDispatcher(new LocalWorkerRuntime(runtime));
}
