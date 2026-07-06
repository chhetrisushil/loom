import type {
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRequest,
  WorkerRuntime,
} from "@loom/worker-runtime";

// Minimal structural fetch types so this package needs no DOM lib. Node 20's
// global fetch and any custom impl satisfy these.
interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
type FetchLike = (input: string, init?: HttpInit) => Promise<HttpResponse>;

export interface RemoteWorkerRuntimeOptions {
  /** Injectable fetch (for tests / custom agents). Defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * The HTTP WorkerRuntime: dispatches an {@link ExecutionPackage} to a stateless
 * worker process over `POST {baseUrl}/execute` and returns the worker's
 * {@link ExecutionResult}. This is the transport that moves execution off-box —
 * `CloudRunWorkerRuntime` (Step 3) is essentially this plus instance
 * lifecycle/placement.
 *
 * There is no client-side execution state: `allocate`/`release` are trivial
 * because the worker rebuilds everything from the shared event + snapshot stores
 * per request. The same package sent twice (start, then resume) works because
 * the worker is stateless across dispatches.
 */
export class RemoteWorkerRuntime implements WorkerRuntime {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, options: RemoteWorkerRuntimeOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    const impl = options.fetchImpl ?? globalFetch;
    if (!impl) {
      throw new Error(
        "RemoteWorkerRuntime requires a fetch implementation (global fetch or fetchImpl)"
      );
    }
    this.fetchImpl = impl;
  }

  async allocate(request: WorkerRequest): Promise<WorkerLease> {
    return {
      leaseId: `remote-${request.executionId}`,
      metadata: { baseUrl: this.baseUrl },
    };
  }

  async execute(_lease: WorkerLease, pkg: ExecutionPackage): Promise<ExecutionResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionPackage: pkg }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`worker POST /execute failed: ${res.status} ${detail}`);
    }
    return (await res.json()) as ExecutionResult;
  }

  async release(_lease: WorkerLease): Promise<void> {
    // Nothing to reclaim client-side; the worker owns its own lifecycle.
  }
}
