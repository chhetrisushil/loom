import {
  type ExecutionPackage,
  type ExecutionResult,
  isSupersededRefusal,
} from "@loom/worker-runtime";
import type { DispatchMetadata, DispatcherHealth, ExecutionDispatcher } from "./types";

export interface CircuitPolicy {
  /** Consecutive dispatch failures before the circuit opens. */
  threshold: number;
  /** How long the circuit stays open before a half-open trial, in ms. */
  cooldownMs: number;
  /** Circuit key for a package. Default: `pkg.flowId` (per-flow breaker). */
  key?: (pkg: ExecutionPackage) => string;
}

export interface SupervisionPolicy {
  /** Restart a *throwing* dispatch up to N extra times (default 0). A returned
   *  "failed" result is a normal outcome, not a restartable error — and neither is a
   *  refusal because another holder owns the execution ({@link isSupersededRefusal},
   *  L20): it is rethrown at once, without a restart and without counting against the
   *  circuit, because restarting it would fence out the holder that won. */
  maxRestarts?: number;
  /** Base backoff between restarts, in ms (default 0). */
  backoffMs?: number;
  /** Exponential growth factor for the backoff (default 2). */
  backoffFactor?: number;
  /** Optional circuit breaker — fail fast when a target is consistently down. */
  circuit?: CircuitPolicy;
}

export class CircuitOpenError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Circuit open for "${key}" — failing fast`);
    this.name = "CircuitOpenError";
    this.key = key;
  }
}

interface Circuit {
  failures: number;
  openedAt: number | null;
}

export interface SupervisingDispatcherOptions {
  policy?: SupervisionPolicy;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Fault supervision (Loom 2.0 K4). A composite {@link ExecutionDispatcher} that wraps
 * a child with an explicit restart/backoff policy and a per-key **circuit breaker**:
 * after `threshold` consecutive dispatch failures the circuit opens and further
 * dispatches fail fast (CircuitOpenError) until a `cooldownMs` half-open trial — so a
 * flaky model/tool/worker is not hammered. Promotes the runtime's ad-hoc
 * retry/redispatch into a named supervision seam; composes over LocalDispatcher /
 * PlacementDispatcher unchanged.
 */
export class SupervisingDispatcher implements ExecutionDispatcher {
  private readonly circuits = new Map<string, Circuit>();
  private readonly policy: SupervisionPolicy;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly child: ExecutionDispatcher,
    options: SupervisingDispatcherOptions = {}
  ) {
    this.policy = options.policy ?? {};
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async dispatch(pkg: ExecutionPackage, meta?: DispatchMetadata): Promise<ExecutionResult> {
    const key = this.policy.circuit?.key?.(pkg) ?? pkg.flowId;
    this.guardCircuit(key); // throws CircuitOpenError if open within cooldown

    const maxRestarts = Math.max(0, this.policy.maxRestarts ?? 0);
    const base = this.policy.backoffMs ?? 0;
    const factor = this.policy.backoffFactor ?? 2;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRestarts; attempt++) {
      try {
        const result = await this.child.dispatch(pkg, meta);
        this.recordSuccess(key);
        return result;
      } catch (err) {
        // L20 — superseded, not failed: not restartable, and not the target's fault. But an
        // EARLIER restart of this dispatch that failed genuinely still counts against the
        // circuit — the refusal ends the dispatch, it does not erase what preceded it.
        if (isSupersededRefusal(err, pkg.executionId)) {
          if (attempt > 0) this.recordFailure(key);
          throw err;
        }
        lastErr = err;
        if (attempt < maxRestarts) await this.sleep(base * factor ** attempt);
      }
    }
    this.recordFailure(key);
    throw lastErr;
  }

  async cancel(executionId: string): Promise<void> {
    return this.child.cancel(executionId);
  }

  async health(): Promise<DispatcherHealth> {
    const h = await this.child.health();
    const open = [...this.circuits.entries()]
      .filter(([, c]) => c.openedAt !== null)
      .map(([k]) => k);
    return {
      healthy: h.healthy && open.length === 0,
      inFlight: h.inFlight,
      ...(open.length > 0
        ? { detail: `circuits-open: ${open.join(",")}` }
        : h.detail !== undefined && { detail: h.detail }),
    };
  }

  private guardCircuit(key: string): void {
    const c = this.circuits.get(key);
    if (c === undefined || c.openedAt === null) return;
    const cooldown = this.policy.circuit?.cooldownMs ?? 0;
    if (this.now() - c.openedAt < cooldown) {
      throw new CircuitOpenError(key);
    }
    // Cooldown elapsed → half-open: allow one trial. Keep the failure count so a
    // fresh failure re-opens immediately; a success resets it.
    c.openedAt = null;
  }

  private recordSuccess(key: string): void {
    // DELETE rather than reset. A circuit with `failures: 0, openedAt: null` is
    // indistinguishable from an absent one everywhere it is read — `guardCircuit`
    // returns on either, `recordFailure` defaults to exactly that shape, and
    // `health()` counts only open circuits — so dropping it is observationally
    // identical and bounds the map to circuits actually accumulating failures.
    //
    // Without this the map only grows. The default key is `flowId` (bounded by
    // deployed flows), but `policy.circuit.key` receives the whole ExecutionPackage,
    // so keying per tenant — or per execution, which reads as natural — turned a
    // supervisor into a leak for the lifetime of the process.
    this.circuits.delete(key);
  }

  private recordFailure(key: string): void {
    const circuit = this.policy.circuit;
    if (circuit === undefined) return;
    const c = this.circuits.get(key) ?? { failures: 0, openedAt: null };
    c.failures += 1;
    if (c.failures >= circuit.threshold) {
      c.openedAt = this.now();
    }
    this.circuits.set(key, c);
  }
}
