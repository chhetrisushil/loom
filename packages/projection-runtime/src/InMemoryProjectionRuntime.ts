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

/**
 * How many least-recently-touched executions eviction will step over looking for an
 * unsubscribed one. Bounds the per-event cost of `touch`; see its comment for why giving up
 * (and sitting one entry over the cap) is the right failure direction.
 */
const EVICTION_SCAN_LIMIT = 64;

/**
 * A registered selector-subscription (see {@link InMemoryProjectionRuntime.subscribeSelector}).
 * `last` holds the previously-seen slice so we can fire only on change; it is seeded from
 * current state at subscribe time (change-only semantics — no initial call).
 */
interface SelectorEntry {
  selector: (state: unknown) => unknown;
  isEqual: (a: unknown, b: unknown) => boolean;
  handler: (slice: unknown) => void;
  last: unknown;
}

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
  // Selector-subscribers, keyed like `subscribers`. Kept separate so whole-state
  // subscription stays a zero-overhead fast path when no selector-subscribers exist.
  private readonly selectorSubscribers = new Map<string, Set<SelectorEntry>>();

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
      this.selectorSubscribers.delete(key);
    }
    this.execOrder.delete(executionId);
  }

  /** True if anything is currently subscribed to any projection of this execution. */
  private hasSubscribers(executionId: string): boolean {
    for (const projectionId of this.projections.keys()) {
      const key = this.stateKey(projectionId, executionId);
      if (this.subscribers.has(key) || this.selectorSubscribers.has(key)) return true;
    }
    return false;
  }

  /**
   * Drop an execution's retained STATE only — never its subscriber registries.
   *
   * The distinction is the whole point. `forget` is an explicit "this execution is done"
   * from a caller who knows it; eviction is a cache decision the caller never made, and
   * dropping a live subscriber's registry there does not degrade — it disconnects. The
   * handler set is captured by closure in `subscribe`, so once the map entry is gone
   * `notify` looks up a key that no longer exists and that subscriber never fires again.
   */
  private evictState(executionId: string): void {
    for (const projectionId of this.projections.keys()) {
      this.states.delete(this.stateKey(projectionId, executionId));
    }
    this.execOrder.delete(executionId);
  }

  private touch(executionId: string): void {
    this.execOrder.delete(executionId);
    this.execOrder.set(executionId, true);
    if (this.execOrder.size <= this.maxExecutions) return;
    // Evict least-recently-touched first, but SKIP anything with a live subscriber:
    // evicting a state someone is folding into resets it to `initialState`, which is
    // corruption rather than a cache miss (the same rule `AgentSurfaceRuntime` follows).
    //
    // The scan is bounded rather than exhaustive: if the oldest entries are all subscribed,
    // giving up costs one over-cap entry, while scanning on would make `touch` — which runs
    // once per event — O(retained). Over the cap is the safe direction; `forget` is the
    // explicit remedy.
    let examined = 0;
    for (const candidate of this.execOrder.keys()) {
      if (examined++ >= EVICTION_SCAN_LIMIT) return;
      if (this.hasSubscribers(candidate)) continue;
      this.evictState(candidate);
      return;
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
      // Only retire the map entry if it is still OUR set. After an explicit `forget`, a later
      // subscriber installs a fresh set under the same key; without this identity check a
      // stale unsubscribe would empty its own orphaned set and then delete the live one,
      // silently disconnecting a subscriber that did nothing wrong.
      if (handlers.size === 0 && this.subscribers.get(key) === handlers) {
        this.subscribers.delete(key);
      }
    };
  }

  subscribeSelector<TState, TSlice>(
    projectionId: string,
    executionId: string,
    selector: (state: TState) => TSlice,
    handler: (slice: TSlice) => void,
    isEqual: (a: TSlice, b: TSlice) => boolean = Object.is
  ): () => void {
    const key = this.stateKey(projectionId, executionId);
    let set = this.selectorSubscribers.get(key);
    if (!set) {
      set = new Set();
      this.selectorSubscribers.set(key, set);
    }
    const sel = selector as (state: unknown) => unknown;
    const entry: SelectorEntry = {
      selector: sel,
      isEqual: isEqual as (a: unknown, b: unknown) => boolean,
      handler: handler as (slice: unknown) => void,
      // Seed from current state so change-only holds from the first event on.
      last: sel(this.peekState(projectionId, executionId)),
    };
    set.add(entry);
    return () => {
      set!.delete(entry);
      // Same identity check as `subscribe` — never retire a set that is no longer ours.
      if (set!.size === 0 && this.selectorSubscribers.get(key) === set) {
        this.selectorSubscribers.delete(key);
      }
    };
  }

  // Current state without throwing for an unregistered/unseen projection (unlike
  // getState) — used to seed a selector-subscription's `last`. resolve-by-path
  // selectors are null-safe, so an absent state seeds cleanly to `undefined`.
  private peekState(projectionId: string, executionId: string): unknown {
    const key = this.stateKey(projectionId, executionId);
    if (this.states.has(key)) return this.states.get(key);
    return this.projections.get(projectionId)?.initialState;
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
    // Own-key lookup: the fold map is user-authored and the event type is caller-controlled,
    // so `handlers["__proto__"]` would resolve to `Object.prototype` — truthy, defeating the
    // `!handler` guard, and then called as a function. Mirrors `getHandler` in @loom/replay-vm.
    if (!Object.hasOwn(handlers, event.eventType)) return;
    const handler = handlers[event.eventType];
    if (typeof handler !== "function") return;
    const key = this.stateKey(projection.id, event.executionId);
    // One `get` on the hot path (this runs per event per projection); `has` is consulted only
    // in the rare case where the retained state is itself `undefined`.
    const retained = this.states.get(key);
    const currentState =
      retained !== undefined || this.states.has(key) ? retained : projection.initialState;
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
    // Selector-subscribers: recompute each slice against the latest state and fire
    // only those whose slice actually changed — so an unrelated slice's update never
    // wakes this subscriber. Snapshot the set so an unsubscribe during iteration
    // (a handler tearing itself down) can't mutate the live set mid-loop.
    const selectors = this.selectorSubscribers.get(key);
    if (selectors) {
      for (const entry of [...selectors]) {
        const next = entry.selector(state);
        if (!entry.isEqual(entry.last, next)) {
          entry.last = next;
          entry.handler(next);
        }
      }
    }
  }
}
