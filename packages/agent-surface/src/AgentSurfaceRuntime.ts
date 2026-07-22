import type { EventEnvelope } from "@loom/core";
import { applySurfacePatches } from "./applyPatch";
import { SURFACE_PATCH, DEFAULT_SURFACE } from "./types";
import type { SurfacePatchPayload, SurfaceState } from "./types";

// The consumer half of the protocol. A standalone, event-sourced surface store:
// feed it the event stream and it folds SURFACE_PATCH events into per-surface,
// per-execution state trees. Framework-agnostic — usable from React, Angular,
// Vue, or a headless client. For React apps that already have a
// ProjectionRuntime, prefer `agentSurfaceProjection` instead (zero extra runtime).
export class AgentSurfaceRuntime {
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly subscribers = new Map<string, Set<(state: SurfaceState) => void>>();

  private key(surface: string, executionId: string): string {
    return `${surface}::${executionId}`;
  }

  handleEvent(event: EventEnvelope): void {
    if (event.eventType !== SURFACE_PATCH) return;
    const payload = event.payload as SurfacePatchPayload;
    const surface = payload.surface ?? DEFAULT_SURFACE;
    const key = this.key(surface, event.executionId);
    const current = this.surfaces.get(key) ?? {};
    const next = applySurfacePatches(current, payload.patches);
    this.surfaces.set(key, next);
    this.notify(key, next);
  }

  getSurface(surface: string, executionId: string): SurfaceState {
    return this.surfaces.get(this.key(surface, executionId)) ?? {};
  }

  seed(surface: string, executionId: string, state: SurfaceState): void {
    this.surfaces.set(this.key(surface, executionId), state);
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
