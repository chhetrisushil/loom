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
}
