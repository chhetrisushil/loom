import type { ExecutionPackage, ExecutionResult } from "@loom/worker-runtime";
import { defaultPlacementPolicy } from "./placement";
import type {
  DispatchMetadata,
  DispatcherHealth,
  ExecutionDispatcher,
  PlacementPolicy,
} from "./types";

export interface PlacementDispatcherOptions {
  /** Named compute targets. Each is a full ExecutionDispatcher (e.g. a LocalDispatcher
   *  wrapping a local / remote-HTTP / Cloud Run WorkerRuntime), so retry/timeout/lease
   *  handling is reused per target. */
  targets: Record<string, ExecutionDispatcher>;
  /** Target used when the policy returns an unregistered name. Must be a key of `targets`. */
  default: string;
  /** How to choose a target. Defaults to "honour meta.target, else default". */
  policy?: PlacementPolicy;
  /**
   * Where to report a dispatch that named an unregistered target (#392). Defaults to
   * `console.warn`. Falling back is correct; doing it silently is how an execution placed
   * on sized compute ends up running somewhere else without anyone noticing.
   */
  onWarn?: (message: string) => void;
}

/**
 * Policy-driven placement (Loom 2.0 M4). A composite {@link ExecutionDispatcher} that
 * routes each dispatch to one of several named targets according to a
 * {@link PlacementPolicy} — the WHERE decision, driven by `ExecutionPolicy`
 * (`dispatchMetadataFromPolicy`). It owns no cloud knowledge: every target is just
 * another ExecutionDispatcher, so local / remote-HTTP / Cloud Run workers compose
 * behind one seam. With a single target it behaves exactly like that target, so
 * existing single-placement dispatch is unchanged.
 */
export class PlacementDispatcher implements ExecutionDispatcher {
  private readonly targets: Record<string, ExecutionDispatcher>;
  private readonly names: string[];
  private readonly defaultTarget: string;
  private readonly policy: PlacementPolicy;
  // Remember where each execution was placed so cancel() reaches the right target.
  // Bounded (LRU-by-insertion) so it can't grow without limit in a long-lived dispatcher.
  private static readonly ROUTED_CAP = 10_000;
  private readonly routed = new Map<string, string>();
  private inFlight = 0;
  private readonly onWarn: (message: string) => void;
  private readonly warnedTargets = new Set<string>();

  constructor(options: PlacementDispatcherOptions) {
    this.names = Object.keys(options.targets);
    if (this.names.length === 0) {
      throw new Error("PlacementDispatcher requires at least one target");
    }
    if (!(options.default in options.targets)) {
      throw new Error(`PlacementDispatcher default target "${options.default}" is not registered`);
    }
    this.targets = options.targets;
    this.defaultTarget = options.default;
    this.policy = options.policy ?? defaultPlacementPolicy(options.default);
    this.onWarn = options.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
  }

  /** The target names currently registered. */
  get targetNames(): readonly string[] {
    return this.names;
  }

  async dispatch(pkg: ExecutionPackage, meta?: DispatchMetadata): Promise<ExecutionResult> {
    // #392 — a placement hint can outlive the lane it names: an execution suspended for days
    // wakes into a deployment where its target was renamed or retired. Falling back is
    // right (a retired lane must not strand what named it) but doing it SILENTLY means an
    // execution deliberately placed on sized compute quietly runs somewhere else forever.
    // Warned once per unknown name — this is a deployment fact, not a per-dispatch event.
    if (meta?.target !== undefined && !this.names.includes(meta.target)) {
      if (!this.warnedTargets.has(meta.target)) {
        this.warnedTargets.add(meta.target);
        this.onWarn(
          `placement target "${meta.target}" is not registered [${this.names.join(", ")}] — falling back to "${this.defaultTarget}". An execution that named it is now running somewhere else.`
        );
      }
    }
    const chosen = this.policy(pkg, meta, this.names);
    const name = chosen in this.targets ? chosen : this.defaultTarget;
    const target = this.targets[name] as ExecutionDispatcher;
    this.routed.set(pkg.executionId, name);
    // Bound `routed` (it would otherwise grow one entry per execution forever). Recent
    // executions — the ones a cancel can still act on — keep their precise target; only a
    // very old execution (evicted here) falls back to the all-targets cancel path, which is
    // harmless (a finished execution ignores a stray cancel). Insertion-ordered eviction.
    if (this.routed.size > PlacementDispatcher.ROUTED_CAP) {
      const oldest = this.routed.keys().next().value;
      if (oldest !== undefined) this.routed.delete(oldest);
    }
    this.inFlight++;
    try {
      return await target.dispatch(pkg, meta);
    } finally {
      this.inFlight--;
    }
  }

  async cancel(executionId: string): Promise<void> {
    const name = this.routed.get(executionId);
    if (name !== undefined) {
      await (this.targets[name] as ExecutionDispatcher).cancel(executionId);
      return;
    }
    // Placement unknown (never dispatched here, or restarted): ask every target.
    await Promise.all(
      this.names.map((n) => (this.targets[n] as ExecutionDispatcher).cancel(executionId))
    );
  }

  async health(): Promise<DispatcherHealth> {
    const healths = await Promise.all(
      this.names.map((n) => (this.targets[n] as ExecutionDispatcher).health())
    );
    return {
      healthy: healths.every((h) => h.healthy),
      inFlight: this.inFlight,
      detail: this.names.map((n, i) => `${n}:${healths[i]?.inFlight ?? 0}`).join(","),
    };
  }
}
