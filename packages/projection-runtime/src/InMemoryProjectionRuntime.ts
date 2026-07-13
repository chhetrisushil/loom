import type { EventEnvelope } from "@loom/core";
import type { Projection, ProjectionFoldMap, ProjectionRuntime } from "./types";

/**
 * The runtime's normalized view of a registered projection. An eager projection has its
 * `handlers` resolved up front; a lazy one gates loading on its `eventTypes` and buffers
 * matching events until its fold code is `import()`-ed (event-type-gated on-demand loading).
 */
interface ActiveProjection {
  id: string;
  initialState: unknown;
  handlers?: ProjectionFoldMap<unknown>;
  // Lazy state — cleared to undefined once resolved into `handlers`.
  eventTypes?: Set<string> | undefined;
  load?: () => Promise<ProjectionFoldMap<unknown>>;
  loading: boolean;
  buffer: EventEnvelope[];
  // Set once a load rejects permanently (a missing/broken chunk is not transient): the
  // projection is abandoned so it can't leak an unbounded buffer or retry-storm the import.
  loadFailed?: boolean;
}

/**
 * Cap on how many matching events a lazy projection buffers while its fold code loads. A local
 * `import()` resolves in well under this window; exceeding it means the load is stuck or broken,
 * so we stop buffering (the projection is a read-model, rebuildable from the log) rather than
 * grow memory without bound. Generous so normal bursts never hit it.
 */
const LAZY_BUFFER_LIMIT = 10_000;

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
  /**
   * Bound how many distinct executions' projection states are retained (LRU by last touch).
   * Prevents unbounded growth in a long-lived server: an execution evicted here reverts to
   * `initialState` on the next `getState` (graceful). Default 10_000; set higher/lower to taste.
   */
  maxExecutions?: number;
}

export class InMemoryProjectionRuntime implements ProjectionRuntime {
  private readonly projections = new Map<string, ActiveProjection>();
  private readonly states = new Map<string, unknown>();
  private readonly subscribers = new Map<string, Set<(state: unknown) => void>>();

  private readonly coalesce: boolean;
  private readonly dirtyKeys = new Set<string>();
  private flushScheduled = false;

  // Insertion order = LRU order over distinct executions, for the retention bound.
  private readonly maxExecutions: number;
  private readonly execOrder = new Map<string, true>();

  constructor(config?: InMemoryProjectionRuntimeConfig) {
    this.coalesce = config?.coalesceNotifications ?? false;
    this.maxExecutions = config?.maxExecutions ?? 10_000;
  }

  /** Drop all retained state + subscribers for an execution (e.g. after it completes). */
  forget(executionId: string): void {
    for (const projectionId of this.projections.keys()) {
      const key = this.stateKey(projectionId, executionId);
      this.states.delete(key);
      this.subscribers.delete(key);
    }
    this.execOrder.delete(executionId);
  }

  private touch(executionId: string): void {
    this.execOrder.delete(executionId);
    this.execOrder.set(executionId, true);
    if (this.execOrder.size > this.maxExecutions) {
      const oldest = this.execOrder.keys().next().value;
      if (oldest !== undefined) this.forget(oldest);
    }
  }

  private stateKey(projectionId: string, executionId: string): string {
    return `${projectionId}::${executionId}`;
  }

  register<TState>(projection: Projection<TState>): void {
    const active: ActiveProjection = {
      id: projection.id,
      initialState: projection.initialState,
      loading: false,
      buffer: [],
      ...(projection.handlers !== undefined && {
        handlers: projection.handlers as ProjectionFoldMap<unknown>,
      }),
      ...(projection.lazy !== undefined && {
        eventTypes: new Set(projection.lazy.eventTypes),
        load: projection.lazy.load as () => Promise<ProjectionFoldMap<unknown>>,
      }),
    };
    this.projections.set(projection.id, active);
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
    for (const [, projection] of this.projections) {
      if (projection.handlers !== undefined) {
        // Eager (or an already-loaded lazy) projection — fold synchronously as before.
        this.apply(projection, projection.handlers, event);
        continue;
      }
      // Lazy projection: gate on the compiler-recorded event types WITHOUT loading the
      // fold code. A non-matching event never touches this projection (0 code loaded).
      // A projection whose load already failed permanently is skipped (no buffer, no retry).
      if (projection.loadFailed === true) continue;
      if (projection.eventTypes?.has(event.eventType) !== true) continue;

      // First matching event: buffer it (and any that arrive during load), kick the
      // one-time import, and drain the buffer in arrival order once the code is ready.
      // Bounded so a stuck/broken load can't grow the buffer without limit.
      if (projection.buffer.length < LAZY_BUFFER_LIMIT) projection.buffer.push(event);
      if (!projection.loading) {
        projection.loading = true;
        projection.load!()
          .then((handlers) => {
            projection.handlers = handlers;
            projection.eventTypes = undefined; // resolved — the eager path takes over
            projection.loading = false;
            const buffered = projection.buffer;
            projection.buffer = [];
            for (const buf of buffered) this.apply(projection, handlers, buf);
          })
          .catch((err) => {
            // A chunk load failure is not transient (missing/broken module). Abandon the
            // projection: free the buffer and stop retrying, rather than leak memory and
            // re-import on every matching event. The read-model can be rebuilt from the log.
            projection.loading = false;
            projection.loadFailed = true;
            projection.buffer = [];
            console.warn(
              `[loom] projection "${projection.id}" failed to load its fold code — it will not update: ${String(err)}`
            );
          });
      }
    }
    this.touch(event.executionId);
  }

  /** Fold one event into a projection's state via the matching handler, then notify. */
  private apply(
    projection: ActiveProjection,
    handlers: ProjectionFoldMap<unknown>,
    event: EventEnvelope
  ): void {
    const handler = handlers[event.eventType];
    if (!handler) return;
    const key = this.stateKey(projection.id, event.executionId);
    const currentState = this.states.has(key) ? this.states.get(key) : projection.initialState;
    const nextState = handler(currentState, event);
    this.states.set(key, nextState);
    this.notify(key, nextState);
  }

  seedState(projectionId: string, executionId: string, state: unknown): void {
    const key = this.stateKey(projectionId, executionId);
    this.states.set(key, state);
    this.touch(executionId);
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
