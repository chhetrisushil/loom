import type {
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRuntime,
} from "@loom/worker-runtime";
import type { DispatchMetadata, DispatcherHealth, ExecutionDispatcher } from "./types";

export interface LocalDispatcherOptions {
  /**
   * How many times to attempt a dispatch before giving up. An attempt fails when
   * the worker throws (transport/allocation error or a crashed instance) or when
   * it exceeds {@link LocalDispatcherOptions.executeTimeoutMs} — NOT when the flow
   * returns a "failed" result, which is a normal terminal outcome. Default 1.
   *
   * Redispatch is safe: the worker is idempotent (it inspects durable state and
   * resumes a crashed execution from its latest snapshot rather than restarting),
   * so a retry continues where the failed attempt left off without re-running
   * completed steps.
   */
  maxAttempts?: number;
  /**
   * Per-attempt deadline. A worker that hangs (a wedged/lost Cloud Run instance)
   * is treated as a failed attempt and redispatched. Omit to wait indefinitely.
   */
  executeTimeoutMs?: number;
}

class DispatchTimeoutError extends Error {}

/**
 * The default Dispatcher. It wraps a single {@link WorkerRuntime} — allocate a
 * lease, execute the package, release the lease — and exposes the placement seam
 * without any cloud awareness. Swapping the worker (Local → Remote → CloudRun)
 * is the only change needed to move execution off-box; callers see the same
 * {@link ExecutionResult} contract.
 */
export class LocalDispatcher implements ExecutionDispatcher {
  private inFlight = 0;
  private readonly maxAttempts: number;
  private readonly executeTimeoutMs: number | undefined;
  private readonly leases = new Map<string, WorkerLease>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly worker: WorkerRuntime,
    options: LocalDispatcherOptions = {}
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    this.executeTimeoutMs = options.executeTimeoutMs;
  }

  async dispatch(pkg: ExecutionPackage, meta?: DispatchMetadata): Promise<ExecutionResult> {
    this.cancelled.delete(pkg.executionId);
    this.inFlight++;
    try {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const lease = await this.worker.allocate({
          executionId: pkg.executionId,
          ...(meta !== undefined && { metadata: meta as Record<string, unknown> }),
        });
        this.leases.set(pkg.executionId, lease);
        try {
          const run = this.worker.execute(lease, pkg);
          return await (this.executeTimeoutMs
            ? withTimeout(run, this.executeTimeoutMs, pkg.executionId)
            : run);
        } catch (err) {
          lastErr = err;
        } finally {
          this.leases.delete(pkg.executionId);
          await this.worker.release(lease);
        }
      }
      throw lastErr;
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Best-effort cancellation. In Step 1 this releases any lease held for the
   * execution and marks it cancelled; true mid-flight interruption (aborting a
   * running worker) is wired in Step 4 alongside timeout + failure redispatch.
   */
  async cancel(executionId: string): Promise<void> {
    this.cancelled.add(executionId);
    const lease = this.leases.get(executionId);
    if (lease) {
      this.leases.delete(executionId);
      await this.worker.release(lease);
    }
  }

  async health(): Promise<DispatcherHealth> {
    return { healthy: true, inFlight: this.inFlight };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, executionId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DispatchTimeoutError(`dispatch timed out after ${ms}ms for ${executionId}`)),
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
