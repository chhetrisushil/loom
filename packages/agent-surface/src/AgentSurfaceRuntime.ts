import type { EventEnvelope } from "@loom/core";
import { applySurfacePatches } from "./applyPatch";
import { DEFAULT_SURFACE, SURFACE_PATCH } from "./types";
import type { SurfacePatchPayload, SurfaceState } from "./types";

// The consumer half of the protocol. A standalone, event-sourced surface store:
// feed it the event stream and it folds SURFACE_PATCH events into per-surface,
// per-execution state trees. Framework-agnostic — usable from React, Angular,
// Vue, or a headless client. For React apps that already have a
// ProjectionRuntime, prefer `agentSurfaceProjection` instead (zero extra runtime).
export interface AgentSurfaceRuntimeOptions {
  /**
   * Cap on retained surface states. Folded state is keyed by (surface, executionId) and
   * executions are unbounded over a process's life, so an unbounded store is a leak in any
   * long-lived consumer — a live dashboard, an MCP app, an A2UI client.
   *
   * Eviction is least-recently-updated, and **skips surfaces with live subscribers**: this
   * is an incremental fold, so dropping a state someone is still watching would silently
   * reset it to `{}` and rebuild from the next patch onward — corruption, not just a cache
   * miss. A subscriber is also holding a reference anyway, so evicting it would not free
   * much. If every retained surface is subscribed, nothing is evicted and the cap is
   * exceeded; that is the safe direction, and `forgetExecution` is the explicit remedy.
   *
   * Default 10,000, matching `PlacementDispatcher`'s routing cap.
   */
  maxSurfaces?: number;
}

export class AgentSurfaceRuntime {
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly subscribers = new Map<string, Set<(state: SurfaceState) => void>>();
  private readonly maxSurfaces: number;

  constructor(options: AgentSurfaceRuntimeOptions = {}) {
    this.maxSurfaces = Math.max(1, options.maxSurfaces ?? 10_000);
  }

  private key(surface: string, executionId: string): string {
    return `${surface}::${executionId}`;
  }

  /** Re-insert so Map insertion order tracks recency, then evict past the cap. */
  private retain(key: string, state: SurfaceState): void {
    this.surfaces.delete(key);
    this.surfaces.set(key, state);
    if (this.surfaces.size <= this.maxSurfaces) return;
    for (const candidate of this.surfaces.keys()) {
      if (this.surfaces.size <= this.maxSurfaces) break;
      // Never evict something a subscriber is folding into.
      if (this.subscribers.has(candidate)) continue;
      this.surfaces.delete(candidate);
    }
  }

  /** Drop one surface's retained state. */
  forget(surface: string, executionId: string): void {
    this.surfaces.delete(this.key(surface, executionId));
  }

  /**
   * Drop every surface retained for an execution — the explicit cleanup a consumer should
   * call when an execution reaches a terminal state. Returns how many were dropped.
   */
  forgetExecution(executionId: string): number {
    const suffix = `::${executionId}`;
    let dropped = 0;
    for (const key of [...this.surfaces.keys()]) {
      if (key.endsWith(suffix)) {
        this.surfaces.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  /** Retained surface states. Exposed so a consumer can assert its own cleanup. */
  get retained(): number {
    return this.surfaces.size;
  }

  handleEvent(event: EventEnvelope): void {
    if (event.eventType !== SURFACE_PATCH) return;
    const payload = event.payload as SurfacePatchPayload;
    const surface = payload.surface ?? DEFAULT_SURFACE;
    const key = this.key(surface, event.executionId);
    const current = this.surfaces.get(key) ?? {};
    const next = applySurfacePatches(current, payload.patches);
    this.retain(key, next);
    this.notify(key, next);
  }

  getSurface(surface: string, executionId: string): SurfaceState {
    return this.surfaces.get(this.key(surface, executionId)) ?? {};
  }

  seed(surface: string, executionId: string, state: SurfaceState): void {
    this.retain(this.key(surface, executionId), state);
  }

  subscribe(
    surface: string,
    executionId: string,
    handler: (state: SurfaceState) => void
  ): () => void {
    const key = this.key(surface, executionId);
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.subscribers.delete(key);
    };
  }

  private notify(key: string, state: SurfaceState): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    for (const handler of set) handler(state);
  }
}
