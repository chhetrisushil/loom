import type { DispatchMetadata } from "@loomwork/dispatcher";
import { RemoteWorkerRuntime } from "@loomwork/plugin-worker-remote";
import type { RemoteWorkerRuntimeOptions } from "@loomwork/plugin-worker-remote";
import type {
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRequest,
  WorkerRuntime,
} from "@loomwork/worker-runtime";
import { defaultSizingPolicy } from "./sizing";
import type { CloudRunConfig, CloudRunPlatform, SizingPolicy } from "./types";

type FetchLike = NonNullable<RemoteWorkerRuntimeOptions["fetchImpl"]>;

export interface CloudRunWorkerRuntimeOptions {
  /** How dispatch hints map to instance size. Defaults to {@link defaultSizingPolicy}. */
  sizing?: SizingPolicy;
  /**
   * Per-request timeout. A worker that returns before this is fine (including a
   * `suspended` result). Exceeding it throws — Cloud Run's own request deadline
   * (≤60 min) is the hard bound; keep this at or under it.
   */
  requestTimeoutMs?: number;
  /** Injectable fetch, forwarded to the per-endpoint RemoteWorkerRuntime. `platform.identity` wraps it. */
  fetchImpl?: FetchLike;
}

interface LeaseState {
  config: CloudRunConfig;
  endpoint: string;
}

/**
 * The Cloud Run WorkerRuntime. It is `RemoteWorkerRuntime` (HTTP transport) plus
 * *placement*: on `allocate` it sizes the execution from the dispatch metadata,
 * asks the {@link CloudRunPlatform} for an endpoint of that size, and invokes the
 * stateless worker there. All Cloud Run specifics live behind the platform SPI;
 * this class only knows the SPI + the worker HTTP contract.
 *
 * Suspend/timeout reconciliation: a worker runs to suspend-or-complete and
 * returns within one request. A `suspended` result is normal; the instance can
 * then scale to zero. Resuming after an approval is a *fresh* dispatch → a fresh
 * `allocate` → possibly a cold instance — which is safe because the worker is
 * stateless and rebuilds from the shared stores.
 */
export class CloudRunWorkerRuntime implements WorkerRuntime {
  private readonly sizing: SizingPolicy;
  private readonly requestTimeoutMs: number | undefined;
  private readonly fetchImpl: FetchLike | undefined;

  constructor(
    private readonly platform: CloudRunPlatform,
    options: CloudRunWorkerRuntimeOptions = {}
  ) {
    this.sizing = options.sizing ?? defaultSizingPolicy;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.fetchImpl = options.fetchImpl;
  }

  async allocate(request: WorkerRequest): Promise<WorkerLease> {
    const meta = request.metadata as DispatchMetadata | undefined;
    const config = this.sizing(meta);
    const endpoint = await this.platform.resolveEndpoint(config);
    this.platform.logs?.log({
      msg: "cloudrun.allocate",
      executionId: request.executionId,
      config,
      endpoint,
    });
    const state: LeaseState = { config, endpoint };
    return {
      leaseId: `cloudrun-${request.executionId}`,
      metadata: state as unknown as Record<string, unknown>,
    };
  }

  async execute(lease: WorkerLease, pkg: ExecutionPackage): Promise<ExecutionResult> {
    const { endpoint } = lease.metadata as unknown as LeaseState;
    const fetchImpl = this.authenticated(endpoint);
    const remote = new RemoteWorkerRuntime(endpoint, fetchImpl ? { fetchImpl } : {});
    const started = performanceNow();
    const run = remote.execute(lease, pkg);
    const result = this.requestTimeoutMs
      ? await withTimeout(run, this.requestTimeoutMs, pkg.executionId)
      : await run;
    this.platform.metrics?.record("cloudrun.execute.ms", performanceNow() - started, {
      status: result.status,
    });
    return result;
  }

  /**
   * With `platform.identity`, every request to this endpoint carries an identity token for it, which
   * a private Cloud Run service requires. The audience is the service URL, so a token is only ever
   * minted for, and sent to, the endpoint it names. A provider that fails fails the dispatch: sending
   * the request without its token would only come back as a 403. Caching tokens is the provider's job.
   */
  private authenticated(endpoint: string): FetchLike | undefined {
    const identity = this.platform.identity;
    if (identity === undefined) return this.fetchImpl;
    const base = this.fetchImpl ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
    if (base === undefined) return undefined; // RemoteWorkerRuntime reports the missing fetch
    const audience = new URL(endpoint).origin;
    return async (input, init) => {
      const token = await identity.getIdentityToken(audience);
      return base(input, {
        ...init,
        headers: { ...init?.headers, authorization: `Bearer ${token}` },
      });
    };
  }

  async release(lease: WorkerLease): Promise<void> {
    const state = lease.metadata as unknown as LeaseState | undefined;
    if (state?.endpoint) {
      await this.platform.release?.(state.endpoint);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, executionId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Cloud Run /execute timed out after ${ms}ms for ${executionId}`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      }
    );
  });
}

function performanceNow(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : 0;
}
