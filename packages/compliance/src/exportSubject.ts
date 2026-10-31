import type { EventEnvelope, ExecutionState } from "@loom/core";
import { type DestructionProof, type EventStore, erasureWindowView } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import type { SubjectIndex } from "./SubjectIndex";

// ── T3-R2/R3 — subject access & portability (GDPR Art. 15/20) ──────────────────
//
// An access/portability request is a fold: gather the subject's executions (from the
// SubjectIndex), read each execution's log, fold it to state. Event-sourcing makes the
// authoritative answer already-present — this just assembles it into a portable shape.
//
// Note on erased subjects: if a field was crypto-shredded, reading through a default
// EncryptingEventStore THROWS (G1). Export a partially-erased subject through a store in
// tolerant mode (`onShredded: "tolerate"`, K10-R4) — the shredded fields come back as
// `{ $shredded }` and the export honestly shows what remains rather than failing.

/** One execution's contribution to a subject export. */
export interface SubjectExecutionExport {
  executionId: string;
  workflowId: string;
  status: ExecutionState["status"];
  /** Folded state — the Art. 15 "access" view (the current data held about the subject). */
  state: ExecutionState;
  /** Raw event log — the Art. 20 "portability" view (machine-readable). Omitted if not requested. */
  events?: EventEnvelope[];
  /**
   * ADR 0138 - checkpoints of a log compacted BEFORE the compaction archive existed (their removed
   * events survive only as a folded state). Present only when such an execution is exported.
   */
  legacyCheckpoints?: unknown[];
}

/** A subject's full data export across every execution concerning them. */
export interface SubjectExport {
  subjectId: string;
  executions: SubjectExecutionExport[];
}

export interface ExportSubjectOptions {
  index: SubjectIndex;
  eventStore: Pick<EventStore, "read">;
  /**
   * ADR 0138 - the compaction archive's audit read (`LogLifecycle`). Compaction MOVES events out of the
   * log into the archive, and an Art. 15/20 export that read only the surviving log would omit the
   * subject's data and fold a compacted log wrongly. Given this, each execution is read as
   * `archive ∪ log` (and folded from that). A range only a pre-archive checkpoint remembers is
   * returned in `legacyCheckpoints` rather than silently missing.
   */
  archive?: {
    readWithArchive(
      executionId: string,
      opts?: { readonly allowIncomplete?: boolean }
    ): Promise<EventEnvelope[]>;
    readLegacyCheckpoints?(executionId: string): Promise<unknown[]>;
  };
  /** Include the raw event log per execution (Art. 20 portability). Default `true`. */
  includeEvents?: boolean;
  /** T3-R2.4 — scope the export to a tenant (default: the single partition). */
  tenant?: string;
  /**
   * ADR 0130 D7 (round 5) - proof that the key store destroyed the subject's key
   * (`(s) => keys.wasDestroyed(s)`). A PROOF function only: returning `true` for a key that was
   * NOT destroyed in the authoritative store produces a false erasure view, so never stub it (use
   * the per-call {@link ExportSubjectOptions.force} for the operator's assertion). Without it, a stream whose key is unavailable is
   * REFUSED (`KeyUnavailableError`) even if the log records an erase intent: a dangling intent
   * (the key still lives elsewhere) is not an erasure.
   */
  destroyed?: DestructionProof;
  /**
   * ADR 0130 D7 (round 6) - OPERATOR OVERRIDE, per call (mirrors `ShredOptions.force`): asserts the
   * key was destroyed in the authoritative key store, for a store that cannot prove it. A wrong
   * assertion exports a redacted view of a subject whose key lives on.
   */
  force?: "key-destroyed-elsewhere";
}

/**
 * Assemble a data-subject export (Art. 15 access + Art. 20 portability): every execution the
 * {@link SubjectIndex} attributes to `subjectId` (within `tenant`), each folded to its current
 * state and (by default) accompanied by its raw log. Executions are emitted in the index's
 * deterministic (sorted) order. An unknown subject yields an empty `executions` array — not an
 * error. Scoping to a tenant is what keeps one tenant's `"alice"` out of another's export.
 */
export async function exportSubject(
  subjectId: string,
  options: ExportSubjectOptions
): Promise<SubjectExport> {
  const includeEvents = options.includeEvents ?? true;
  const executionIds = options.index.executionsOf(subjectId, options.tenant);
  const executions: SubjectExecutionExport[] = [];
  for (const executionId of executionIds) {
    let events: EventEnvelope[];
    try {
      events =
        options.archive !== undefined
          ? await options.archive.readWithArchive(executionId, { allowIncomplete: true })
          : await options.eventStore.read(executionId);
    } catch (err) {
      // The ShredIncomplete window (key destroyed, tombstone not yet written): the redacted view,
      // only with the log's durable erase intent. A node that lacks the key is not an erasure.
      const window = await erasureWindowView(
        err,
        options.force === "key-destroyed-elsewhere" ? () => true : options.destroyed
      );
      if (window === undefined) throw err;
      events = [...window];
    }
    if (events.length === 0) continue; // deleted (retention) — nothing left to export
    // Seed the fold with identity — foldEvents takes executionId/workflowId from `initial`,
    // not the events, so an unseeded fold would carry empty identity fields.
    const workflowId = events[0]?.workflowId ?? "";
    const state = foldEvents(events, { executionId, workflowId });
    const legacy = (await options.archive?.readLegacyCheckpoints?.(executionId)) ?? [];
    executions.push({
      executionId,
      workflowId,
      status: state.status,
      state,
      ...(includeEvents && { events }),
      ...(legacy.length > 0 && { legacyCheckpoints: legacy }),
    });
  }
  return { subjectId, executions };
}
