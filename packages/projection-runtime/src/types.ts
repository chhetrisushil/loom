import type { EventEnvelope } from "@loom/core";

export interface Projection<TState> {
  id: string;
  initialState: TState;
  handlers: {
    [eventType: string]: (state: TState, event: EventEnvelope) => TState;
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
}
