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
  private readonly routed = new Map<string, string>();
  private inFlight = 0;

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
  }

  /** The target names currently registered. */
  get targetNames(): readonly string[] {
    return this.names;
  }

  async dispatch(pkg: ExecutionPackage, meta?: DispatchMetadata): Promise<ExecutionResult> {
    const chosen = this.policy(pkg, meta, this.names);
    const name = chosen in this.targets ? chosen : this.defaultTarget;
    const target = this.targets[name] as ExecutionDispatcher;
    this.routed.set(pkg.executionId, name);
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
    await Promise.all(this.names.map((n) => (this.targets[n] as ExecutionDispatcher).cancel(executionId)));
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
