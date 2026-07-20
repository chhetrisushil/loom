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
  /**
   * Fine-grained ("selector") subscription: invoke `handler` only when
   * `selector(state)` changes — by `isEqual`, default `Object.is` — rather than on
   * every projection event. The framework-agnostic building block for live rendering
   * surfaces (terminal, editor webview, TUI, …): each derives a slice-granular,
   * memoized subscription from the shared read-model without reimplementing the diff.
   *
   * Change-only, exactly like {@link subscribe}: it does NOT fire on subscribe. The
   * last slice is seeded from current state at subscribe time, so the first `handler`
   * call is the first genuine change. Read the initial value via `getState` + selector.
   * Participates in `coalesceNotifications` — a burst collapses to one call per changed
   * slice per microtask.
   */
  subscribeSelector<TState, TSlice>(
    projectionId: string,
    executionId: string,
    selector: (state: TState) => TSlice,
    handler: (slice: TSlice) => void,
    isEqual?: (a: TSlice, b: TSlice) => boolean
  ): () => void;
  handleEvent(event: EventEnvelope): void;
  seedState(projectionId: string, executionId: string, state: unknown): void;
}
