import type { EventEnvelope } from "@loom/core";
import type { Projection, ProjectionRuntime } from "./types";

export interface InMemoryProjectionRuntimeConfig {
  /**
   * Coalesce subscriber notifications. When true, instead of notifying
   * synchronously on every event, dirty keys are collected and flushed once per
   * microtask with each projection's LATEST state. A streaming burst of N events
   * (e.g. one LLM token per event) collapses from N subscriber calls to 1 per
   * affected key, cutting downstream re-renders without changing final state.
   *
   * Off by default: notifications stay synchronous, preserving exact current
   * semantics and adding zero overhead unless explicitly enabled.
   */
  coalesceNotifications?: boolean;
}

export class InMemoryProjectionRuntime implements ProjectionRuntime {
  private readonly projections = new Map<string, Projection<unknown>>();
  private readonly states = new Map<string, unknown>();
  private readonly subscribers = new Map<string, Set<(state: unknown) => void>>();

  private readonly coalesce: boolean;
  private readonly dirtyKeys = new Set<string>();
  private flushScheduled = false;

  constructor(config?: InMemoryProjectionRuntimeConfig) {
    this.coalesce = config?.coalesceNotifications ?? false;
  }

  private stateKey(projectionId: string, executionId: string): string {
    return `${projectionId}::${executionId}`;
  }

  register<TState>(projection: Projection<TState>): void {
    this.projections.set(projection.id, projection as Projection<unknown>);
  }

  getState<TState>(projectionId: string, executionId: string): TState {
    const key = this.stateKey(projectionId, executionId);
    if (this.states.has(key)) {
      return this.states.get(key) as TState;
    }
    const projection = this.projections.get(projectionId);
    if (!projection) {
      throw new Error(`Projection "${projectionId}" is not registered`);
    }
    return projection.initialState as TState;
  }

  subscribe<TState>(
    projectionId: string,
    executionId: string,
    handler: (state: TState) => void
  ): () => void {
    const key = this.stateKey(projectionId, executionId);
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    const handlers = this.subscribers.get(key)!;
    const wrapper = (s: unknown) => handler(s as TState);
    handlers.add(wrapper);
    return () => {
      handlers.delete(wrapper);
      if (handlers.size === 0) {
        this.subscribers.delete(key);
      }
    };
  }

  handleEvent(event: EventEnvelope): void {
    for (const [projectionId, projection] of this.projections) {
      const handler = projection.handlers[event.eventType];
      if (!handler) continue;

      const key = this.stateKey(projectionId, event.executionId);
      const currentState = this.states.has(key) ? this.states.get(key) : projection.initialState;

      const nextState = handler(currentState, event);
      this.states.set(key, nextState);
      this.notify(key, nextState);
    }
  }

  seedState(projectionId: string, executionId: string, state: unknown): void {
    const key = this.stateKey(projectionId, executionId);
    this.states.set(key, state);
  }

  private notify(key: string, state: unknown): void {
    if (!this.coalesce) {
      this.emit(key, state);
      return;
    }
    // Defer: mark dirty and flush once per microtask with the latest state.
    this.dirtyKeys.add(key);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    const keys = Array.from(this.dirtyKeys);
    this.dirtyKeys.clear();
    for (const key of keys) {
      // Read the current state so subscribers always see the latest value even
      // when many events for the same key arrived within the batch.
      this.emit(key, this.states.get(key));
    }
  }

  private emit(key: string, state: unknown): void {
    const handlers = this.subscribers.get(key);
    if (handlers) {
      for (const handler of handlers) {
        handler(state);
      }
    }
  }
}
