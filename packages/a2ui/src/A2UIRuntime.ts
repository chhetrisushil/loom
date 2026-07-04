import type { EventEnvelope } from "@loom/core";
import { applyA2UIPatches } from "./applyPatch";
import { A2UI_PATCH, DEFAULT_SURFACE } from "./types";
import type { A2UIPatchPayload, A2UISurfaceState } from "./types";

// The consumer half of the protocol. A standalone, event-sourced surface store:
// feed it the event stream and it folds A2UI_PATCH events into per-surface,
// per-execution state trees. Framework-agnostic — usable from React, Angular,
// Vue, or a headless client. For React apps that already have a
// ProjectionRuntime, prefer `a2uiSurfaceProjection` instead (zero extra runtime).
export class A2UIRuntime {
  private readonly surfaces = new Map<string, A2UISurfaceState>();
  private readonly subscribers = new Map<string, Set<(state: A2UISurfaceState) => void>>();

  private key(surface: string, executionId: string): string {
    return `${surface}::${executionId}`;
  }

  handleEvent(event: EventEnvelope): void {
    if (event.eventType !== A2UI_PATCH) return;
    const payload = event.payload as A2UIPatchPayload;
    const surface = payload.surface ?? DEFAULT_SURFACE;
    const key = this.key(surface, event.executionId);
    const current = this.surfaces.get(key) ?? {};
    const next = applyA2UIPatches(current, payload.patches);
    this.surfaces.set(key, next);
    this.notify(key, next);
  }

  getSurface(surface: string, executionId: string): A2UISurfaceState {
    return this.surfaces.get(this.key(surface, executionId)) ?? {};
  }

  seed(surface: string, executionId: string, state: A2UISurfaceState): void {
    this.surfaces.set(this.key(surface, executionId), state);
  }

  subscribe(
    surface: string,
    executionId: string,
    handler: (state: A2UISurfaceState) => void
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

  private notify(key: string, state: A2UISurfaceState): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    for (const handler of set) handler(state);
  }
}
