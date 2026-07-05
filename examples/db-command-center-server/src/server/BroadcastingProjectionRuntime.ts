import { A2UI_PATCH } from "@loom/a2ui";
import type { EventEnvelope } from "@loom/core";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import type { Projection, ProjectionRuntime } from "@loom/projection-runtime";
import { serializeProjections } from "@loom/workflow-runtime";

// ── BroadcastingProjectionRuntime ─────────────────────────────────────────────
//
// A ProjectionRuntime decorator for the server. It delegates everything to an
// InMemoryProjectionRuntime, but after folding an event it forwards the
// mission's A2UI surface patches to connected SSE clients — so the browser can
// mirror the surfaces the Orchestrator drives, without the client running any of
// the agentic backend.
//
// Only `A2UI_PATCH` envelopes for this mission are broadcast; the durable flows'
// STEP_* events (different execution ids) fold locally and are not streamed.
export class BroadcastingProjectionRuntime implements ProjectionRuntime {
  private readonly inner = new InMemoryProjectionRuntime();

  constructor(
    private readonly missionId: string,
    private readonly surfaces: string[],
    private readonly onPatch: (envelope: EventEnvelope) => void
  ) {}

  register<TState>(projection: Projection<TState>): void {
    this.inner.register(projection);
  }

  getState<TState>(projectionId: string, executionId: string): TState {
    return this.inner.getState<TState>(projectionId, executionId);
  }

  subscribe<TState>(
    projectionId: string,
    executionId: string,
    handler: (state: TState) => void
  ): () => void {
    return this.inner.subscribe(projectionId, executionId, handler);
  }

  seedState(projectionId: string, executionId: string, state: unknown): void {
    this.inner.seedState(projectionId, executionId, state);
  }

  handleEvent(event: EventEnvelope): void {
    this.inner.handleEvent(event);
    if (event.eventType === A2UI_PATCH && event.executionId === this.missionId) {
      this.onPatch(event);
    }
  }

  // A serialized ProjectionSnapshot of every tracked surface — sent to a client
  // the moment it connects so it seeds instantly (resumability seam).
  snapshot(): string {
    const states: Record<string, unknown> = {};
    for (const surface of this.surfaces) {
      states[surface] = this.inner.getState(surface, this.missionId);
    }
    return serializeProjections(states, this.missionId);
  }
}
