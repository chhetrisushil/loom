import type { EventEnvelope } from "@loom/core";
import type {
  CatchUpReport,
  ExtractedRow,
  ReadModelDefinition,
  ReadModelEventSource,
  ReadModelPage,
  ReadModelQuery,
  ReadModelRow,
  ReadModelStore,
} from "./types";

/** Reserved control streams (`__loom_*`) are kernel bookkeeping — never indexed. */
function isReservedStream(executionId: string): boolean {
  return executionId.startsWith("__loom_");
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
  private readonly byKind = new Map<string, ReadModelDefinition[]>();
  private readonly onError: (err: unknown, event: EventEnvelope) => void;

  constructor(
    private readonly store: ReadModelStore,
    options: ReadModelServiceOptions = {}
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
    if (this.models.has(model.id)) {
      throw new TypeError(`read model "${model.id}" is already registered`);
    }
    this.models.set(model.id, model);
    for (const kind of model.kinds) {
      const list = this.byKind.get(kind);
      if (list === undefined) this.byKind.set(kind, [model]);
      else list.push(model);
    }
  }

  /** Live tail — synchronous fan-out, asynchronous durable apply (never throws into the pipeline). */
  handleEvent(event: EventEnvelope): void {
    if (isReservedStream(event.executionId)) return;
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
    const report: CatchUpReport = { executionsScanned: 0, eventsScanned: 0, rowsApplied: 0 };
    for (const source of sources) {
      if (source.listExecutions === undefined) {
        throw new TypeError(
          "ReadModelService.catchUp: every event source must support listExecutions() — a source that cannot be enumerated cannot be indexed completely"
        );
      }
      const executionIds = (await source.listExecutions()).filter((id) => !isReservedStream(id));
      for (const executionId of executionIds) {
        report.executionsScanned++;
        for (const model of this.models.values()) {
          const mark = await this.store.watermark(model.id, executionId);
          const events = await source.readFrom(executionId, mark === null ? 0 : mark + 1);
          if (events.length === 0) continue;
          report.eventsScanned += events.length;
          const rows: ReadModelRow[] = [];
          for (const event of events) {
            if (model.kinds.includes(event.eventType)) rows.push(...toRows(model, event));
          }
          const tip = events[events.length - 1]!.sequence;
          await this.store.apply(model.id, executionId, tip, rows);
          report.rowsApplied += rows.length;
        }
      }
    }
    return report;
  }

  query(modelId: string, q?: ReadModelQuery): Promise<ReadModelPage> {
    if (!this.models.has(modelId)) {
      return Promise.reject(new TypeError(`read model "${modelId}" is not registered`));
    }
    return this.store.query(modelId, q);
  }

  /** RM-2 — the read model is a cache: drop it and re-derive from the log. */
  async rebuild(modelId: string, sources: readonly ReadModelEventSource[]): Promise<CatchUpReport> {
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
