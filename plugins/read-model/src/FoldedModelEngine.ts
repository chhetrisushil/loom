import { loadProjectionHandlers, projectionEventTypes } from "@loom/core";
import type { EventEnvelope, ProjectionHandlers } from "@loom/core";
import type {
  FoldBase,
  FoldedEngineOptions,
  FoldedReadModelDefinition,
  FoldedRecord,
  ReadModelStore,
} from "./types";
import { FoldGapError, FoldVersionMismatchError } from "./types";

export type FoldedStore = Required<
  Pick<
    ReadModelStore,
    "beginFold" | "applyFolded" | "getFolded" | "getFoldedByKey" | "purgeFolded" | "clear"
  >
>;

/** All five folded methods or none (ADR 0132 D6). */
export function foldedCapable(store: ReadModelStore): store is ReadModelStore & FoldedStore {
  return (
    store.beginFold !== undefined &&
    store.applyFolded !== undefined &&
    store.getFolded !== undefined &&
    store.getFoldedByKey !== undefined &&
    store.purgeFolded !== undefined
  );
}

/** Live contiguity pointers kept per node (ADR 0132 D4). Losing one costs a store read, never correctness. */
const FRONTIER_MAX = 10_000;
const slot = (modelId: string, executionId: string): string => `${modelId}\u0000${executionId}`;

export interface FoldedModel {
  id: string;
  version: string;
  initial: unknown;
  handlers: ProjectionHandlers<unknown>;
  keyOf?: (executionId: string) => string | undefined;
  scopeOf?: (executionId: string) => string | undefined;
}

/** Persist-shaped state: JSON round trip per event, so incremental == batch (ADR 0132 D4). */
function normalize(model: FoldedModel, next: unknown): unknown {
  if (next === undefined || next === null) {
    throw new TypeError(
      `folded read model "${model.id}": a handler returned ${next} — state must be a JSON value other than null (null means "no handled event yet")`
    );
  }
  const text = JSON.stringify(next);
  if (text === undefined) {
    throw new TypeError(`folded read model "${model.id}": state is not JSON-serializable`);
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null) {
    throw new TypeError(
      `folded read model "${model.id}": state must be a JSON value other than null (NaN/Infinity serialize to null)`
    );
  }
  return parsed;
}

export class FoldedModelEngine {
  protected readonly models = new Map<string, FoldedModel>();
  private readonly queues = new Map<string, Promise<void>>();
  /** (model, execution) -> highest sequence this node has accounted for on the live feed. Map order = recency. */
  private readonly frontier = new Map<string, number>();

  constructor(
    protected readonly store: FoldedStore,
    protected readonly onError: (err: unknown, event: EventEnvelope) => void,
    protected readonly options: FoldedEngineOptions = {}
  ) {}

  has(modelId: string): boolean {
    return this.models.has(modelId);
  }
  get size(): number {
    return this.models.size;
  }
  ids(): string[] {
    return [...this.models.keys()];
  }
  versions(): [string, string][] {
    return [...this.models.values()].map((m) => [m.id, m.version]);
  }

  async register<S>(def: FoldedReadModelDefinition<S>): Promise<{ rebuilt: boolean }> {
    const p = def.projection;
    const version = typeof p.version === "string" ? p.version.trim() : undefined;
    if (version === undefined || version === "") {
      throw new TypeError(
        `folded read model "${p.id}": a version is required — a durable fold cannot be rebuilt when it changes without one (ADR 0132 D5)`
      );
    }
    if (this.models.has(p.id)) throw new TypeError(`read model "${p.id}" is already registered`);
    const handlers = (await loadProjectionHandlers(p.handlers)) as ProjectionHandlers<unknown>;
    if (projectionEventTypes(p.handlers).length === 0) {
      throw new TypeError(`folded read model "${p.id}": handlers must be non-empty`);
    }
    const { rebuilt } = await this.store.beginFold(p.id, version);
    if (this.models.has(p.id)) throw new TypeError(`read model "${p.id}" is already registered`);
    const model: FoldedModel = {
      id: p.id,
      version,
      initial: p.initialState,
      handlers,
      ...(def.keyOf !== undefined && { keyOf: def.keyOf }),
      ...(def.scopeOf !== undefined && { scopeOf: def.scopeOf }),
    };
    this.models.set(p.id, model);
    return { rebuilt };
  }

  async mark(modelId: string, executionId: string): Promise<FoldedRecord | undefined> {
    return (await this.store.getFolded(modelId, [executionId]))[0];
  }

  /**
   * Fold `events` (those past the record's watermark) and CAS-write. True when the write applied.
   * The first event folded must be `watermark + 1`, or at most `accounted + 1` when the caller has
   * itself accounted for the events up to `accounted` (unhandled ones; Task 4a2). A hole is a
   * `FoldGapError` and nothing is written (ADR 0132 D4, ADR 0058 D2: the watermark may advance past
   * events no handler matched, but never past events nobody has seen).
   */
  async foldBatch(
    modelId: string,
    executionId: string,
    rec: FoldBase | undefined,
    events: readonly EventEnvelope[],
    accounted?: number
  ): Promise<boolean> {
    const model = this.models.get(modelId);
    if (model === undefined)
      throw new TypeError(`read model "${modelId}" is not a registered folded model`);
    const from = rec?.sequence ?? -1;
    const todo = events.filter((e) => e.sequence > from);
    if (todo.length === 0) return false;
    const frontier = Math.max(from, accounted ?? from);
    if (todo[0]!.sequence > frontier + 1) {
      throw new FoldGapError(modelId, executionId, frontier, todo[0]!.sequence);
    }
    // Every event must follow its predecessor: rejects mid-batch holes, duplicates and unsorted batches.
    for (let i = 1; i < todo.length; i++) {
      if (todo[i]!.sequence !== todo[i - 1]!.sequence + 1) {
        throw new FoldGapError(modelId, executionId, todo[i - 1]!.sequence, todo[i]!.sequence);
      }
    }
    const erased = rec?.erased === true;
    // Clone the base once: a mutating handler must not touch the caller's record or cache.
    let state: unknown = rec?.state == null ? null : structuredClone(rec.state);
    if (!erased) {
      // The event envelope is passed as-is; the masked copy of Task 5c owns isolating it from handlers.
      for (const e of todo) {
        if (!Object.hasOwn(model.handlers, e.eventType)) continue;
        const handler = model.handlers[e.eventType]!;
        const base = state === null ? structuredClone(model.initial) : state;
        state = normalize(model, handler(base, e));
      }
    }
    const result = await this.store.applyFolded({
      modelId,
      executionId,
      upToSequence: todo[todo.length - 1]!.sequence,
      state,
      key: model.keyOf?.(executionId) ?? null,
      scope: model.scopeOf?.(executionId) ?? null,
      foldVersion: model.version,
    });
    if (result === "version-mismatch") throw new FoldVersionMismatchError(modelId, model.version);
    return result === "applied";
  }

  /**
   * Live tail: the engine is shown EVERY event of an execution (ADR 0132 D4). Serialized per
   * (model, execution); errors go to `onError`, never into the pipeline.
   */
  handle(event: EventEnvelope): void {
    for (const model of this.models.values()) {
      void this.enqueue(model.id, event.executionId, () => this.applyLive(model, event)).catch(
        (err) => this.onError(err, event)
      );
    }
  }

  async drain(): Promise<void> {
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  protected enqueue<T>(modelId: string, executionId: string, job: () => Promise<T>): Promise<T> {
    const k = slot(modelId, executionId);
    const next = (this.queues.get(k) ?? Promise.resolve()).then(job);
    const tail = next.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(k, tail);
    void tail.then(() => {
      if (this.queues.get(k) === tail) this.queues.delete(k);
    });
    return next;
  }

  /** Forget a model's live pointers (its stored state was reset, so they no longer describe it). */
  protected dropFrontier(modelId: string): void {
    const prefix = `${modelId}\u0000`;
    for (const k of [...this.frontier.keys()]) if (k.startsWith(prefix)) this.frontier.delete(k);
  }

  private setFrontier(k: string, sequence: number): void {
    this.frontier.delete(k);
    this.frontier.set(k, sequence);
    if (this.frontier.size > FRONTIER_MAX) {
      const oldest = this.frontier.keys().next().value;
      if (oldest !== undefined) this.frontier.delete(oldest);
    }
  }

  /** An event no handler matches: bookkeeping only, no write (ADR 0058 D2 semantics without a write per event). */
  private observe(k: string, sequence: number): void {
    const through = this.frontier.get(k);
    if (through === undefined) {
      if (sequence === 0) this.setFrontier(k, 0); // the first event of an execution: nothing precedes it
    } else if (sequence === through + 1) this.setFrontier(k, sequence);
    else if (sequence > through + 1) this.frontier.delete(k); // a hole this node did not observe: stop vouching
  }

  private async applyLive(model: FoldedModel, event: EventEnvelope): Promise<void> {
    const id = event.executionId;
    const k = slot(model.id, id);
    if (!Object.hasOwn(model.handlers, event.eventType)) {
      this.observe(k, event.sequence);
      return;
    }
    const rec = await this.mark(model.id, id);
    const from = rec?.sequence ?? -1;
    if (event.sequence <= from) return;
    const accounted = Math.max(from, this.frontier.get(k) ?? -1);
    let events: readonly EventEnvelope[];
    let through = accounted;
    if (event.sequence === accounted + 1) events = [event];
    else if (this.options.liveSource !== undefined) {
      events = await this.options.liveSource.readFrom(id, from + 1);
      through = from;
      // A source that cannot reach the event leaves the hole open: report it, never fold part-way.
      if (!events.some((e) => e.sequence >= event.sequence)) {
        throw new FoldGapError(model.id, id, from, event.sequence);
      }
    } else throw new FoldGapError(model.id, id, accounted, event.sequence);
    await this.foldBatch(model.id, id, rec, events, through);
    // Applied, or "stale" (another node got there first): either way the store is at least this far.
    const last = events[events.length - 1];
    if (last !== undefined) this.setFrontier(k, last.sequence);
  }
}
