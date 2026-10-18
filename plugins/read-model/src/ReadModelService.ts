import { checkVersionPins } from "@loom/core";
import type { EventEnvelope, PinReport } from "@loom/core";
import { iterateExecutionIds } from "@loom/event-runtime";
import { FoldedModelEngine, foldedCapable } from "./FoldedModelEngine";
import type {
  CatchUpReport,
  ExtractedRow,
  FoldCacheOptions,
  FoldedReadModelDefinition,
  FoldedReadOptions,
  FoldedSelector,
  FoldedState,
  ReadModelDefinition,
  ReadModelEventSource,
  ReadModelPage,
  ReadModelQuery,
  ReadModelRow,
  ReadModelScalar,
  ReadModelStore,
  RefreshOptions,
  SensitiveMap,
} from "./types";
import { FoldedUnsupportedError, PurgeUnsupportedError, assertPurgeFilter } from "./types";

/**
 * Reserved control streams (`__loom_*`) are kernel bookkeeping — never indexed. Nor is the
 * blank id, which names no execution (ADR 0107).
 */
function isReservedStream(executionId: string): boolean {
  return executionId === "" || executionId.startsWith("__loom_");
}

function toRows(model: ReadModelDefinition, event: EventEnvelope): ReadModelRow[] {
  const extracted = model.extract(event);
  const rows: ReadModelRow[] = [];
  const seen = new Set<string>();
  for (const row of extracted) {
    assertDeclaredFields(model, row);
    const rowId = row.rowKey === undefined ? event.id : `${event.id}#${row.rowKey}`;
    if (seen.has(rowId)) {
      throw new TypeError(
        `read model "${model.id}": extractor returned duplicate rowId "${rowId}" for event "${event.id}" — give each row a distinct rowKey`
      );
    }
    seen.add(rowId);
    rows.push({
      rowId,
      executionId: event.executionId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      kind: event.eventType,
      fields: row.fields,
      value: row.value !== undefined ? row.value : event.payload,
    });
  }
  return rows;
}

function assertDeclaredFields(model: ReadModelDefinition, row: ExtractedRow): void {
  for (const field of Object.keys(row.fields)) {
    if (!model.indexes.includes(field)) {
      throw new TypeError(
        `read model "${model.id}": extractor set undeclared field "${field}" — declare it in \`indexes\` so backends can index it`
      );
    }
  }
}

export interface ReadModelServiceOptions {
  /**
   * Live-ingestion errors are reported here (the `onEvent` path is
   * fire-and-forget by contract — a throwing read model must never break the
   * execution's event pipeline). Catch-up errors THROW instead. Default:
   * rethrow asynchronously (crash loudly rather than drop silently).
   */
  onError?: (err: unknown, event: EventEnvelope) => void;
  /**
   * Fills a genuine hole in the live tail (ADR 0132 D4) — a node that restarts mid-execution, a
   * missed event; normally this node's own event store. Optional: the engine is shown every event
   * of an execution it follows from the start, so unhandled events are not holes.
   */
  liveSource?: ReadModelEventSource;
  /** Sensitive payload paths every folded model must never see (D11) — the map you gave `EncryptingEventStore`. */
  sensitive?: SensitiveMap;
  /** Per-node state cache for the live apply path (D15). Default on; `false` disables. */
  foldCache?: FoldCacheOptions | false;
}

/**
 * RM-1 — the ingestion + query engine over a {@link ReadModelStore}.
 *
 * Two convergent feeds: `handleEvent` (wire into `defineConfig({ onEvent })` —
 * the same in-process path projections use) and `catchUp(sources)` (restart
 * recovery, other nodes' events, K10.1 archive stores — RM-4). Both funnel
 * through the store's idempotent `apply`, so at-least-once delivery from any
 * mix of feeds converges; watermarks make catch-up incremental (`readFrom`
 * skips applied history — the RM-1 cold-start property).
 */
export class ReadModelService {
  private readonly models = new Map<string, ReadModelDefinition>();
  /** `definition.kinds` as a Set, built at registration — see the catch-up scan for why. */
  private readonly kindSets = new Map<string, ReadonlySet<string>>();
  private readonly byKind = new Map<string, ReadModelDefinition[]>();
  private readonly onError: (err: unknown, event: EventEnvelope) => void;
  private folded?: FoldedModelEngine;

  constructor(
    private readonly store: ReadModelStore,
    private readonly options: ReadModelServiceOptions = {}
  ) {
    this.onError =
      options.onError ??
      ((err) => {
        setImmediate(() => {
          throw err;
        });
      });
  }

  register(model: ReadModelDefinition): void {
    if (model.kinds.length === 0) {
      throw new TypeError(`read model "${model.id}": kinds must be non-empty`);
    }
    if (this.models.has(model.id) || this.folded?.has(model.id)) {
      throw new TypeError(`read model "${model.id}" is already registered`);
    }
    this.models.set(model.id, model);
    this.kindSets.set(model.id, new Set(model.kinds));
    for (const kind of model.kinds) {
      const list = this.byKind.get(kind);
      if (list === undefined) this.byKind.set(kind, [model]);
      else list.push(model);
    }
  }

  /** Register a folded-state model (ADR 0132 D13). One id namespace with row models. */
  async registerFolded<S>(def: FoldedReadModelDefinition<S>): Promise<{ rebuilt: boolean }> {
    const id = def.projection.id;
    if (this.models.has(id)) throw new TypeError(`read model "${id}" is already registered`);
    if (!foldedCapable(this.store)) throw new FoldedUnsupportedError(id);
    this.folded ??= new FoldedModelEngine(this.store, this.onError, {
      ...(this.options.liveSource !== undefined && { liveSource: this.options.liveSource }),
      ...(this.options.sensitive !== undefined && { sensitive: this.options.sensitive }),
      ...(this.options.foldCache !== undefined && { cache: this.options.foldCache }),
    });
    return this.folded.register(def);
  }

  /** Live tail — synchronous fan-out, asynchronous durable apply (never throws into the pipeline). */
  handleEvent(event: EventEnvelope): void {
    if (isReservedStream(event.executionId)) return;
    this.folded?.handle(event); // every event, handled or not: the engine needs contiguity
    const interested = this.byKind.get(event.eventType);
    if (interested === undefined) return;
    for (const model of interested) {
      try {
        const rows = toRows(model, event);
        void this.store
          .apply(model.id, event.executionId, event.sequence, rows)
          .catch((err) => this.onError(err, event));
      } catch (err) {
        this.onError(err, event);
      }
    }
  }

  /**
   * Incremental catch-up over one or more event sources (live store first,
   * K10.1 archive stores after — RM-4). A source that cannot be enumerated
   * makes the scan REFUSE: silent under-indexing would masquerade as "no
   * results" in decisional-layer queries.
   */
  async catchUp(sources: readonly ReadModelEventSource[]): Promise<CatchUpReport> {
    return this.scan(sources);
  }

  /**
   * The shared scan: ONE `readFrom` per execution from the minimum frontier across row AND folded
   * models. `only` narrows it to one FOLDED model (rebuild); row models are scanned only when it is
   * absent. A folded refusal (gap, sensitive state, version mismatch) throws to the caller.
   */
  private async scan(
    sources: readonly ReadModelEventSource[],
    only?: string
  ): Promise<CatchUpReport> {
    const report: CatchUpReport = { executionsScanned: 0, eventsScanned: 0, rowsApplied: 0 };
    const rowModels = only === undefined ? [...this.models.values()] : [];
    const folded = this.folded;
    const foldedIds =
      folded === undefined ? [] : folded.ids().filter((id) => only === undefined || id === only);
    for (const source of sources) {
      if (source.listExecutions === undefined && source.listExecutionsPage === undefined) {
        throw new TypeError(
          "ReadModelService.catchUp: every event source must support listExecutionsPage() or listExecutions() — a source that cannot be enumerated cannot be indexed completely"
        );
      }
      // SP-2 — bounded-memory enumeration: pages when the source supports them.
      for await (const executionId of iterateExecutionIds(source)) {
        if (isReservedStream(executionId)) continue;
        report.executionsScanned++;
        if (rowModels.length === 0 && foldedIds.length === 0) continue;
        // Audit fix (DS&A rank 1): ONE shared read per execution from the MIN
        // watermark frontier, filtered per model — not M re-reads of the same
        // events for M models. Idempotent apply keeps correctness unchanged.
        const marks = new Map<string, number>();
        let frontier = Number.POSITIVE_INFINITY;
        for (const model of rowModels) {
          const mark = (await this.store.watermark(model.id, executionId)) ?? -1;
          marks.set(model.id, mark);
          if (mark < frontier) frontier = mark;
        }
        for (const id of foldedIds) {
          const mark = (await folded?.mark(id, executionId))?.sequence ?? -1;
          marks.set(id, mark);
          if (mark < frontier) frontier = mark;
        }
        const events = await source.readFrom(executionId, frontier + 1);
        if (events.length === 0) continue;
        report.eventsScanned += events.length;
        const tip = events[events.length - 1]!.sequence;
        for (const model of rowModels) {
          const from = marks.get(model.id)!;
          if (tip <= from) continue; // this model is already past everything read
          // Set, not the declared array: this is the per-EVENT test on the catch-up
          // scan, so a linear `kinds.includes` runs models x events x kinds over the
          // whole log. Built once per model at registration.
          const kinds = this.kindSets.get(model.id)!;
          const rows: ReadModelRow[] = [];
          for (const event of events) {
            if (event.sequence > from && kinds.has(event.eventType)) {
              rows.push(...toRows(model, event));
            }
          }
          await this.store.apply(model.id, executionId, tip, rows);
          report.rowsApplied += rows.length;
        }
        for (const id of foldedIds) {
          if (tip <= marks.get(id)!) continue;
          // Through the per-(model, execution) queue, not around it (ADR 0132 D4).
          await folded?.foldQueued(id, executionId, events, marks.get(id));
        }
      }
    }
    return report;
  }

  async getMany<S = unknown>(
    modelId: string,
    executionIds: readonly string[],
    opts?: FoldedReadOptions
  ): Promise<Map<string, FoldedState<S>>> {
    return this.engine(modelId).getMany(modelId, executionIds, opts) as Promise<
      Map<string, FoldedState<S>>
    >;
  }

  async getManyByKey<S = unknown>(
    modelId: string,
    keys: readonly string[],
    opts?: FoldedReadOptions
  ): Promise<Map<string, FoldedState<S>[]>> {
    return this.engine(modelId).getManyByKey(modelId, keys, opts) as Promise<
      Map<string, FoldedState<S>[]>
    >;
  }

  /** Fold each execution's log tail past its watermark; resolves to the number advanced (D8). */
  async refresh(
    modelId: string,
    executionIds: readonly string[],
    sources: readonly ReadModelEventSource[],
    opts?: RefreshOptions
  ): Promise<number> {
    return this.engine(modelId).refresh(modelId, executionIds, sources, opts);
  }

  /**
   * Erase folded state by exactly one of executionId / key / scope (D12). A tombstone for an
   * execution that exists; rebuild un-tombstones — see ADR 0132 D12 for the tolerant-source
   * obligation.
   */
  async purgeFolded(modelId: string, selector: FoldedSelector): Promise<number> {
    return this.engine(modelId).purge(modelId, selector);
  }

  /** Await this node's in-flight live applies (tests, graceful shutdown). */
  async drain(): Promise<void> {
    await this.folded?.drain();
  }

  private engine(modelId: string): FoldedModelEngine {
    if (this.folded === undefined || !this.folded.has(modelId)) {
      throw new TypeError(`read model "${modelId}" is not a registered folded model`);
    }
    return this.folded;
  }

  query(modelId: string, q?: ReadModelQuery): Promise<ReadModelPage> {
    if (!this.models.has(modelId)) {
      return Promise.reject(new TypeError(`read model "${modelId}" is not registered`));
    }
    return this.store.query(modelId, q);
  }

  /**
   * Delete the rows matching `where` — row-granular erasure (ADR 0093).
   *
   * The compliance path: a crypto-shred erases the log, and the derived rows keep
   * whatever the extractor copied out before the key died. Purging by the subject's
   * indexed field removes exactly those rows, at the cost of the rows rather than the
   * cost of the log.
   *
   * Two refusals rather than one silent success, because an erasure that quietly did
   * nothing is worse than one that failed:
   *  - a field the model never declared as an index (it can match no row, so a filter
   *    naming it would report a successful erasure of zero rows), and
   *  - a backend without {@link ReadModelStore.purge} ({@link PurgeUnsupportedError}) —
   *    catch it and `rebuild` if the *O(log)* fallback is acceptable.
   */
  async purge(modelId: string, where: Record<string, ReadModelScalar>): Promise<number> {
    const model = this.models.get(modelId);
    if (model === undefined) {
      throw new TypeError(`read model "${modelId}" is not registered`);
    }
    assertPurgeFilter(where);
    for (const field of Object.keys(where)) {
      if (!model.indexes.includes(field)) {
        throw new TypeError(
          `read model "${modelId}": purge filter names undeclared field "${field}" — only indexed fields are stored on a row, so this filter could never match`
        );
      }
    }
    if (this.store.purge === undefined) throw new PurgeUnsupportedError(modelId);
    return this.store.purge(modelId, where);
  }

  /**
   * ADR 0095 — the declared `version` of every registered model that has one, by id.
   *
   * Models declaring nothing are absent rather than present-and-empty: a key mapped to `""`
   * would compare equal to another empty declaration and read as a verified match.
   */
  pins(): Readonly<Record<string, string>> {
    // No prototype — see `emptyPins` in @loom/blueprint-runtime: a model id of `__proto__`
    // would otherwise set one rather than add a key, and drop out of every report silently.
    const pins: Record<string, string> = Object.create(null);
    for (const [id, model] of this.models) {
      if (model.version !== undefined) pins[id] = model.version;
    }
    // The effective stored version (version + sensitive-map digest), so a changed map drifts.
    for (const [id, version] of this.folded?.versions() ?? []) pins[id] = version;
    return pins;
  }

  /**
   * ADR 0095 — were these models still the models a derived artifact was built against?
   *
   * `recorded` is what the caller wrote down when it produced something from these rows (a
   * report, a saved view, an exported number). A `drift` finding means the rows now in the
   * store were not all produced by the extractor the artifact assumed, and the exit is
   * {@link ReadModelService.rebuild} — nothing else can repair rows whose watermark has
   * already passed them.
   *
   * A QUERY, deliberately: it clears nothing, rebuilds nothing and applies nothing, so
   * looking before you leap is not itself the leap. Same shape as
   * `A2UISurfaceBridge.identityDiff`.
   */
  checkPins(recorded: Readonly<Record<string, string>>): PinReport {
    const current = this.pins();
    // Scoped to what the caller recorded: another model's version drifting says nothing
    // about the artifact in hand, and which models an artifact used is only the caller's
    // to know.
    const scoped: Record<string, string> = Object.create(null);
    for (const id of Object.keys(recorded)) {
      const now = current[id];
      if (now !== undefined) scoped[id] = now;
    }
    return checkVersionPins(recorded, scoped);
  }

  /** RM-2 — the read model is a cache: drop it and re-derive from the log. */
  async rebuild(modelId: string, sources: readonly ReadModelEventSource[]): Promise<CatchUpReport> {
    if (this.folded?.has(modelId)) {
      // Gated reset (drops the frontier under the gate), then a scan of this model alone.
      await this.folded.reset(modelId);
      return this.scan(sources, modelId);
    }
    if (!this.models.has(modelId)) {
      throw new TypeError(`read model "${modelId}" is not registered`);
    }
    await this.store.clear(modelId);
    // Scope the scan to just this model by running catch-up with a narrowed view.
    const only = new ReadModelService(this.store, { onError: this.onError });
    only.register(this.models.get(modelId)!);
    return only.catchUp(sources);
  }
}
