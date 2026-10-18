import { loadProjectionHandlers, projectionEventTypes } from "@loom/core";
import type { EventEnvelope, ProjectionHandlers } from "@loom/core";
import { FoldStateCache } from "./foldStateCache";
import { effectiveFoldVersion, mergeSensitive } from "./sensitiveConfig";
import { foldView } from "./sensitiveInput";
import { SensitiveStateError, assertStateClean } from "./sensitiveState";
import type {
  FoldBase,
  FoldedApplyResult,
  FoldedEngineOptions,
  FoldedReadModelDefinition,
  FoldedReadOptions,
  FoldedRecord,
  FoldedSelector,
  FoldedState,
  ReadModelEventSource,
  ReadModelStore,
  RefreshOptions,
  SensitiveMap,
} from "./types";
import {
  DEFAULT_FOLD_CACHE_ENTRIES,
  FoldGapError,
  FoldVersionMismatchError,
  assertManyKeys,
} from "./types";

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
/** The event with payload and metadata removed: what `onError` sees for a sensitive-state refusal. */
const withheld = (e: EventEnvelope): EventEnvelope => {
  const { payload: _p, metadata: _m, ...rest } = e;
  return { ...rest, payload: null } as EventEnvelope;
};
const slot = (modelId: string, executionId: string): string => `${modelId}\u0000${executionId}`;

/** The CAS result of a fold and the record it wrote (only present when `result` is "applied"). */
export interface FoldOutcome {
  result: FoldedApplyResult | "noop";
  record?: FoldBase;
}

export interface FoldedModel {
  id: string;
  version: string;
  initial: unknown;
  handlers: ProjectionHandlers<unknown>;
  /** Effective declared sensitive paths: service map ∪ per-model map (D11). */
  sensitive: SensitiveMap;
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

function toState(r: FoldedRecord): FoldedState<unknown> | undefined {
  if (r.erased || r.state === null) return undefined;
  return { executionId: r.executionId, key: r.key, sequence: r.sequence, state: r.state };
}

const refreshOptions = (o: FoldedReadOptions): RefreshOptions =>
  o.concurrency === undefined ? {} : { concurrency: o.concurrency };

export class FoldedModelEngine {
  protected readonly models = new Map<string, FoldedModel>();
  private readonly queues = new Map<string, Promise<void>>();
  /** modelId -> open while `reset` runs: jobs for that model start only after it is released. */
  private readonly gates = new Map<string, Promise<void>>();
  /** (model, execution) -> highest sequence this node has accounted for on the live feed. Map order = recency. */
  private readonly frontier = new Map<string, number>();
  /** Fold bases this node wrote (D15); undefined when disabled. Write-path only: no read API touches it. */
  private readonly cache: FoldStateCache | undefined;

  constructor(
    protected readonly store: FoldedStore,
    protected readonly onError: (err: unknown, event: EventEnvelope) => void,
    protected readonly options: FoldedEngineOptions = {}
  ) {
    const c = options.cache;
    const max = c === false ? 0 : (c?.maxEntries ?? DEFAULT_FOLD_CACHE_ENTRIES);
    this.cache = max > 0 ? new FoldStateCache(max) : undefined;
  }

  cacheSize(): number {
    return this.cache?.size ?? 0;
  }

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
    const declaredVersion = typeof p.version === "string" ? p.version.trim() : undefined;
    if (declaredVersion === undefined || declaredVersion === "") {
      throw new TypeError(
        `folded read model "${p.id}": a version is required — a durable fold cannot be rebuilt when it changes without one (ADR 0132 D5)`
      );
    }
    if (this.models.has(p.id)) throw new TypeError(`read model "${p.id}" is already registered`);
    const sensitive = mergeSensitive(this.options.sensitive, def.sensitive);
    const version = effectiveFoldVersion(declaredVersion, sensitive);
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
      sensitive,
      ...(def.keyOf !== undefined && { keyOf: def.keyOf }),
      ...(def.scopeOf !== undefined && { scopeOf: def.scopeOf }),
    };
    this.models.set(p.id, model);
    this.cache?.deleteModel(p.id);
    return { rebuilt };
  }

  async mark(modelId: string, executionId: string): Promise<FoldedRecord | undefined> {
    return (await this.store.getFolded(modelId, [executionId]))[0];
  }

  async getMany(
    modelId: string,
    executionIds: readonly string[],
    opts: FoldedReadOptions = {}
  ): Promise<Map<string, FoldedState<unknown>>> {
    this.require(modelId);
    assertManyKeys(executionIds, "getMany");
    if (opts.refreshFrom !== undefined) {
      await this.refresh(modelId, executionIds, opts.refreshFrom, refreshOptions(opts));
    }
    const out = new Map<string, FoldedState<unknown>>();
    for (const r of await this.store.getFolded(modelId, executionIds)) {
      const s = toState(r);
      if (s !== undefined) out.set(r.executionId, s);
    }
    return out;
  }

  /**
   * With `refreshFrom`, only the executions that ALREADY have a row for these keys are refreshed
   * (two key queries around the refresh). An execution with no row yet has no key to find: refresh
   * it by id (`getMany` / `refresh`). ADR 0132 D8/D9.
   */
  async getManyByKey(
    modelId: string,
    keys: readonly string[],
    opts: FoldedReadOptions = {}
  ): Promise<Map<string, FoldedState<unknown>[]>> {
    this.require(modelId);
    assertManyKeys(keys, "getManyByKey");
    let records = await this.store.getFoldedByKey(modelId, keys);
    if (opts.refreshFrom !== undefined && records.length > 0) {
      await this.refresh(
        modelId,
        records.map((r) => r.executionId),
        opts.refreshFrom,
        refreshOptions(opts)
      );
      records = await this.store.getFoldedByKey(modelId, keys);
    }
    const out = new Map<string, FoldedState<unknown>[]>();
    for (const r of records) {
      const s = toState(r);
      if (s === undefined || r.key === null) continue;
      const list = out.get(r.key);
      if (list === undefined) out.set(r.key, [s]);
      else list.push(s);
    }
    return out;
  }

  /**
   * Read-repair (ADR 0132 D8): fold each execution's log tail past its watermark, on the
   * per-(model, execution) queue so it serializes behind any in-flight live apply. The final
   * watermark is persisted even when the tail is unhandled and adopted into the live frontier.
   * Returns the number of executions whose watermark advanced.
   */
  async refresh(
    modelId: string,
    executionIds: readonly string[],
    sources: readonly ReadModelEventSource[],
    opts: RefreshOptions = {}
  ): Promise<number> {
    const model = this.require(modelId);
    assertManyKeys(executionIds, "refresh");
    const concurrency = opts.concurrency ?? 8;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(
        `folded read model refresh: concurrency must be a positive integer (got ${concurrency})`
      );
    }
    const ids = [...new Set(executionIds)];
    let advanced = 0;
    for (let i = 0; i < ids.length; i += concurrency) {
      await Promise.all(
        ids.slice(i, i + concurrency).map((id) =>
          this.enqueue(model.id, id, async () => {
            const rec = await this.mark(model.id, id);
            for (const source of sources) {
              const events = await source.readFrom(id, (rec?.sequence ?? -1) + 1);
              if (events.length === 0) continue;
              if (await this.foldBatch(model.id, id, rec, events)) advanced++;
              // Applied or stale: the store is at least this far, so the live tail must not report a gap.
              // Never move it backwards: the live feed may have observed further unhandled events.
              const k = slot(model.id, id);
              this.setFrontier(
                k,
                Math.max(this.frontier.get(k) ?? -1, events[events.length - 1]!.sequence)
              );
              break;
            }
          })
        )
      );
    }
    return advanced;
  }

  async purge(modelId: string, selector: FoldedSelector): Promise<number> {
    this.require(modelId);
    const set = Object.entries(selector).filter(([, v]) => v !== undefined);
    const [field, value] = set[0] ?? [];
    if (set.length !== 1 || typeof value !== "string" || value.trim() === "") {
      throw new TypeError(
        "folded read model purge: the selector must name exactly one of executionId / key / scope, non-blank — an empty selector is not 'every row' (that is `clear`)"
      );
    }
    // Behind a running reset, so purgeFolded never overlaps clear (a tombstone would be lost).
    await this.gates.get(modelId);
    // One snapshot is enough: a later apply reads the sticky erased record and writes no state (D12).
    await Promise.all([...this.queues.values()]);
    const n = await this.store.purgeFolded(modelId, { [field!]: value } as FoldedSelector);
    this.cache?.deleteModel(modelId);
    return n;
  }

  /**
   * Drop the model's states and re-create its header (the caller then runs a catch-up scan).
   * Exclusive: jobs for the model queue behind a gate until the reset is done, so none can
   * re-seed the frontier from, or write over, the rows being cleared.
   */
  async reset(modelId: string): Promise<void> {
    const model = this.require(modelId);
    const before = this.gates.get(modelId);
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    this.gates.set(modelId, gate);
    const prefix = `${modelId}\u0000`;
    const inFlight = [...this.queues].filter(([k]) => k.startsWith(prefix)).map(([, q]) => q);
    try {
      await Promise.all([before, ...inFlight]);
      this.dropFrontier(modelId); // the live pointers described states that are about to be gone
      this.cache?.deleteModel(modelId); // ... and so do the cached bases
      await this.store.clear(modelId);
      await this.store.beginFold(modelId, model.version);
    } finally {
      if (this.gates.get(modelId) === gate) this.gates.delete(modelId);
      open();
    }
  }

  private require(modelId: string): FoldedModel {
    const model = this.models.get(modelId);
    if (model === undefined)
      throw new TypeError(`read model "${modelId}" is not a registered folded model`);
    return model;
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
    try {
      return (
        (await this.foldOutcome(modelId, executionId, rec, events, accounted)).result === "applied"
      );
    } finally {
      // Catch-up, refresh and rebuild move the row behind any cached base: the live path re-reads.
      this.cache?.delete(modelId, executionId);
    }
  }

  /** As {@link foldBatch}, but reports the CAS result and the record this write persisted. */
  protected async foldOutcome(
    modelId: string,
    executionId: string,
    rec: FoldBase | undefined,
    events: readonly EventEnvelope[],
    accounted?: number
  ): Promise<FoldOutcome> {
    const model = this.models.get(modelId);
    if (model === undefined)
      throw new TypeError(`read model "${modelId}" is not a registered folded model`);
    const from = rec?.sequence ?? -1;
    const todo = events.filter((e) => e.sequence > from);
    if (todo.length === 0) return { result: "noop" };
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
      // Each handler gets a fresh masked copy, never the shared envelope (D11). The state that is
      // checked is the SAME object that is persisted: normalize() already JSON round-tripped it.
      for (const e of todo) {
        if (!Object.hasOwn(model.handlers, e.eventType)) continue;
        const handler = model.handlers[e.eventType]!;
        const base = state === null ? structuredClone(model.initial) : state;
        const view = foldView(modelId, e, model.sensitive);
        state = normalize(model, handler(base, view.event));
        // `lifted` is per event, deliberately not accumulated across the batch, so live (1 event)
        // and catch-up (N events) refuse identically (D14).
        assertStateClean(
          { modelId, executionId, eventType: e.eventType, sequence: e.sequence },
          state,
          view.lifted
        );
      }
    }
    const upToSequence = todo[todo.length - 1]!.sequence;
    const result = await this.store.applyFolded({
      modelId,
      executionId,
      upToSequence,
      state,
      key: model.keyOf?.(executionId) ?? null,
      scope: model.scopeOf?.(executionId) ?? null,
      foldVersion: model.version,
    });
    if (result === "version-mismatch") {
      this.cache?.deleteModel(modelId); // another node rebuilt: no cached base for this model is trustworthy
      throw new FoldVersionMismatchError(modelId, model.version);
    }
    return { result, record: { sequence: upToSequence, state, erased } };
  }

  /**
   * Live tail: the engine is shown EVERY event of an execution (ADR 0132 D4). Serialized per
   * (model, execution); errors go to `onError`, never into the pipeline. For a `SensitiveStateError`
   * the event passed to `onError` has its payload and metadata removed (the refused secret is never handed on).
   */
  handle(event: EventEnvelope): void {
    for (const model of this.models.values()) {
      void this.enqueue(model.id, event.executionId, () => this.applyLive(model, event)).catch(
        (err) => {
          // A throwing onError is swallowed: it must not become an unhandled rejection.
          try {
            // A guard refusal must not hand the plaintext event to onError (it may be logged).
            this.onError(err, err instanceof SensitiveStateError ? withheld(event) : event);
          } catch {
            /* swallowed by design */
          }
        }
      );
    }
  }

  async drain(): Promise<void> {
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  protected enqueue<T>(modelId: string, executionId: string, job: () => Promise<T>): Promise<T> {
    const k = slot(modelId, executionId);
    const gate = this.gates.get(modelId);
    const prev = this.queues.get(k) ?? Promise.resolve();
    const next = (gate === undefined ? prev : Promise.all([prev, gate]).then(() => undefined)).then(
      job
    );
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
    // `useCache` is true only on the first pass; every retry goes to the store.
    for (let useCache = this.cache !== undefined; ; useCache = false) {
      // take() removes the entry: if anything below throws, the key is absent, never half-folded.
      const cached = useCache ? this.cache?.take(model.id, id) : undefined;
      const rec: FoldBase | undefined = cached ?? (await this.mark(model.id, id));
      const from = rec?.sequence ?? -1;
      // The store (or this node's own last write, when cached) covers everything through `from`:
      // never let the frontier lag it (a lagging pointer would drop on the next unhandled event
      // and turn the following handled one into a spurious gap).
      if ((this.frontier.get(k) ?? -1) < from) this.setFrontier(k, from);
      if (event.sequence <= from) {
        if (cached !== undefined) this.cache?.put(model.id, id, cached); // still a valid guess
        return;
      }
      const accounted = Math.max(from, this.frontier.get(k) ?? -1);
      let events: readonly EventEnvelope[];
      let through = accounted;
      if (event.sequence === accounted + 1) events = [event];
      else if (cached !== undefined)
        continue; // the cache never decides a gap: another node may be ahead
      else if (this.options.liveSource !== undefined) {
        events = await this.options.liveSource.readFrom(id, from + 1);
        through = from;
        // A source that cannot reach the event leaves the hole open: report it, never fold part-way.
        if (!events.some((e) => e.sequence >= event.sequence)) {
          throw new FoldGapError(model.id, id, from, event.sequence);
        }
      } else throw new FoldGapError(model.id, id, accounted, event.sequence);
      const out = await this.foldOutcome(model.id, id, rec, events, through);
      if (out.result === "applied" && out.record !== undefined) {
        // Only this node's own applied write is cached, and it is the exact state that was persisted.
        this.cache?.put(model.id, id, out.record);
      } else if (out.result === "stale" && cached !== undefined) {
        continue; // lost the CAS on a possibly stale base: drop it (taken) and re-read once
      }
      // Applied, or "stale" (another node got there first): either way the store is at least this far.
      const last = events[events.length - 1];
      if (last !== undefined) this.setFrontier(k, last.sequence);
      return;
    }
  }
}
