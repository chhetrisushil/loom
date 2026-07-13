import type { EventEnvelope } from "@loom/core";

export type ProjectionFoldMap<TState> = {
  [eventType: string]: (state: TState, event: EventEnvelope) => TState;
};

export interface Projection<TState> {
  id: string;
  initialState: TState;
  /** The eager fold map — present when handlers are inline / already resolved. */
  handlers?: ProjectionFoldMap<TState>;
  /**
   * Event-type-gated lazy form: the fold code stays unloaded until an event whose type
   * is in `eventTypes` first arrives, at which point `load()` is `import()`-ed once (its
   * events buffered until ready). A projection whose event types never fire never loads
   * its code. Exactly one of `handlers` / `lazy` should be set.
   */
  lazy?: {
    eventTypes: string[];
    load: () => Promise<ProjectionFoldMap<TState>>;
  };
}

export interface ProjectionRuntime {
  register<TState>(projection: Projection<TState>): void;
  getState<TState>(projectionId: string, executionId: string): TState;
  subscribe<TState>(
    projectionId: string,
    executionId: string,
    handler: (state: TState) => void
  ): () => void;
  handleEvent(event: EventEnvelope): void;
  seedState(projectionId: string, executionId: string, state: unknown): void;
}
