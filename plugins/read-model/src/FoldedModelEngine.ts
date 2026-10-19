import { loadProjectionHandlers, projectionEventTypes } from "@loom/core";
import type { EventEnvelope, ProjectionHandlers } from "@loom/core";
import { FoldStateCache } from "./foldStateCache";
import { effectiveFoldVersion, mergeSensitive } from "./sensitiveConfig";
import { foldView } from "./sensitiveInput";
import { assertStateClean } from "./sensitiveState";
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
  FoldedStateValueError,
  assertFoldedSelector,
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
/** The event with payload and metadata removed: what the folded engine's `onError` always sees (any error kind). */
const withheld = (e: EventEnvelope): EventEnvelope => {
  const { payload: _p, metadata: _m, ...rest } = e;
  return { ...rest, payload: null } as EventEnvelope;
};
const slot = (modelId: string, executionId: string): string => `${modelId}\u0000${executionId}`;

/** The CAS result of a fold and the record it wrote (present when `result` is "applied" or "applied-erased"). */
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
  return canonical(model.id, parsed, "$");
}

const utf8 = new TextEncoder();
const BAD_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkString(modelId: string, s: string, path: string): void {
  if (s.includes("\u0000")) throw new FoldedStateValueError(modelId, path, "nul");
  if (BAD_SURROGATE.test(s)) throw new FoldedStateValueError(modelId, path, "lone-surrogate");
}

/** Postgres JSONB key order: shorter UTF-8 key first, then bytewise (ADR 0132 D14). */
function compareJsonbKeys(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * Re-key every object into JSONB's order and refuse strings no backend stores identically, so the
 * cache, SQLite, Postgres and memory all hand a handler the same bytes (D14). Never echoes a value.
 */
function canonical(modelId: string, v: unknown, path: string): unknown {
  if (typeof v === "string") {
    checkString(modelId, v, path);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => canonical(modelId, x, `${path}[${i}]`));
  if (typeof v !== "object" || v === null) return v;
  const entries = Object.keys(v).map((k) => {
    checkString(modelId, k, `${path}.<key>`);
    return [k, utf8.encode(k)] as const;
  });
  entries.sort((a, b) => compareJsonbKeys(a[1], b[1]));
  return Object.fromEntries(
    entries.map(([k]) => [k, canonical(modelId, (v as Record<string, unknown>)[k], `${path}.${k}`)])
  );
}

/** The records a read-only reader may show: erased and "no handled event yet" rows are omitted (same rule as `getMany`). */
export function foldedStates(records: readonly FoldedRecord[]): FoldedState<unknown>[] {
  const out: FoldedState<unknown>[] = [];
  for (const r of records) {
    const s = toState(r);
    if (s !== undefined) out.push(s);
  }
  return out;
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
  /**
   * modelId -> counter bumped whenever cached bases may have become untrustworthy (purge, register,
   * reset, version mismatch). An apply that began before a bump never caches its result.
   */
  private readonly generations = new Map<string, number>();

  constructor(
    protected readonly store: FoldedStore,
    protected readonly onError: (err: unknown, event: EventEnvelope) => void,
    protected readonly options: FoldedEngineOptions = {}
  ) {
    const c = options.cache;
    const max = c === false ? 0 : (c?.maxEntries ?? DEFAULT_FOLD_CACHE_ENTRIES);
    this.cache = max > 0 ? new FoldStateCache(max) : undefined;
  }

  private generation(modelId: string): number {
    return this.generations.get(modelId) ?? 0;
  }

  private invalidate(modelId: string): void {
    this.generations.set(modelId, this.generation(modelId) + 1);
    this.cache?.deleteModel(modelId);
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
    this.invalidate(p.id);
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

  /**
   * Fold catch-up / rebuild events for one execution on the same per-(model, execution) queue as the
   * live path (ADR 0132 D4), against the watermark as it stands when the job runs. The final
   * watermark is adopted into the live frontier, never backwards. A refusal (gap, sensitive state,
   * version mismatch) rejects and adopts nothing. `seen` is the watermark the scan read before
   * queueing: if the job finds a LOWER one, the model was reset meanwhile and this stale tail is
   * dropped untouched (the post-reset scan heals it); any other hole still throws.
   */
  foldQueued(
    modelId: string,
    executionId: string,
    events: readonly EventEnvelope[],
    seen?: number
  ): Promise<boolean> {
    return this.enqueue(modelId, executionId, async () => {
      const rec = await this.mark(modelId, executionId);
      if (seen !== undefined && (rec?.sequence ?? -1) < seen) return false;
      const applied = await this.foldBatch(modelId, executionId, rec, events);
      const last = events[events.length - 1];
      if (last !== undefined) {
        const k = slot(modelId, executionId);
        this.setFrontier(k, Math.max(this.frontier.get(k) ?? -1, last.sequence));
      }
      return applied;
    });
  }

  /** Raise (never lower) the live pointer to a watermark the catch-up scan found already current. */
  seedFrontier(modelId: string, executionId: string): Promise<void> {
    // On the queue, re-reading the mark: a reset between the scan and now must not leave a stale pointer.
    return this.enqueue(modelId, executionId, async () => {
      const mark = (await this.mark(modelId, executionId))?.sequence ?? -1;
      if (mark < 0) return;
      const k = slot(modelId, executionId);
      this.setFrontier(k, Math.max(this.frontier.get(k) ?? -1, mark));
    });
  }

  async purge(modelId: string, selector: FoldedSelector): Promise<number> {
    this.require(modelId);
    assertFoldedSelector(selector);
    const [[field, value]] = Object.entries(selector).filter(([, v]) => v !== undefined) as [
      [string, string],
    ];
    // Behind a running reset, so purgeFolded never overlaps clear (a tombstone would be lost).
    await this.gates.get(modelId);
    // One snapshot is enough: a later apply's CAS lands on the sticky erased row and writes no state
    // (D12). The generation is bumped before AND after the store call so no apply that overlapped
    // the purge can re-cache its pre-purge base.
    await Promise.all([...this.queues.values()]);
    this.invalidate(modelId);
    try {
      return await this.store.purgeFolded(modelId, { [field]: value } as FoldedSelector);
    } finally {
      this.invalidate(modelId);
    }
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
      this.invalidate(modelId); // ... and so do the cached bases
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
        (await this.foldOutcome(modelId, executionId, rec, events, accounted)).record !== undefined
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
      this.invalidate(modelId); // another node rebuilt: no cached base for this model is trustworthy
      throw new FoldVersionMismatchError(modelId, model.version);
    }
    if (result === "stale") return { result };
    // "applied-erased": the row was tombstoned elsewhere; remember that, never the folded state.
    const gone = erased || result === "applied-erased";
    return { result, record: { sequence: upToSequence, state: gone ? null : state, erased: gone } };
  }

  /**
   * Live tail: the engine is shown EVERY event of an execution (ADR 0132 D4). Serialized per
   * (model, execution); errors go to `onError`, never into the pipeline. For EVERY error kind the event
   * passed to `onError` has its payload and metadata removed (ids, type and sequence only), so a logger
   * can never print a secret.
   */
  handle(event: EventEnvelope): void {
    for (const model of this.models.values()) {
      void this.enqueue(model.id, event.executionId, () => this.applyLive(model, event)).catch(
        (err) => {
          // A throwing onError is swallowed: it must not become an unhandled rejection.
          try {
            // Never hand the plaintext event to onError (it may be logged).
            this.onError(err, withheld(event));
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
      const gen = this.generation(model.id);
      let cached = useCache ? this.cache?.take(model.id, id) : undefined;
      let rec: FoldBase | undefined = cached;
      if (cached?.erased === true) {
        // An erased marker is a hint only (D15): another node may have rebuilt the row since, and
        // folding from this base would insert a partial state. Re-read; still erased -> as before.
        const fresh = await this.mark(model.id, id);
        if (fresh?.erased !== true) {
          cached = undefined;
          this.frontier.delete(k); // the pointer described the row as another node has since replaced it
        }
        rec = fresh;
      } else rec ??= await this.mark(model.id, id);
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
      if (out.record !== undefined) {
        // Only this node's own applied write is cached (the exact state persisted, or the erased
        // marker), and only if no purge/reset/register/mismatch happened while it was in flight.
        if (gen === this.generation(model.id)) this.cache?.put(model.id, id, out.record);
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
