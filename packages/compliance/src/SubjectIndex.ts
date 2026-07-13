import type { EventEnvelope } from "@loom/core";

// ── T3 — the subject index (data-subject rights) ──────────────────────────────
//
// GDPR Art. 15/20 (access, portability) and Art. 17 (erasure) all start with one question:
// "which records concern this person?" Event-sourcing answers it structurally — every fact
// is in the log — but you still need the person→records mapping. This index maintains it as
// a fold over the event stream: `subjectId → { executionIds }`, plus the O(1) reverse.
//
// The kernel supplies no notion of "data subject" (G3 — that is policy). The app names the
// subject via a `SubjectResolver`: given an event, return the subject it concerns (usually
// read off EXECUTION_STARTED input, e.g. the userId), or `undefined` for events that name
// no subject. The resolver runs once per (execution, first-resolved) — the mapping is
// per-execution stable, so later events for a known execution are O(1) skips.

/** Given an event, the data subject it concerns — or `undefined` if it names none. */
export type SubjectResolver = (event: EventEnvelope) => string | undefined;

/**
 * A live, rebuildable index of `subjectId → executionIds`. Feed it the event stream
 * (`handleEvent`, e.g. from `defineConfig`'s `onEvent`) or rebuild from a log
 * ({@link SubjectIndex.fromEvents}) — both yield the same state (P2). Backed by a
 * `Map<subject, Set<execution>>` for O(1) membership + a reverse `Map<execution, subject>`
 * for O(1) dedupe and lookup, so a burst of events for one execution is not re-resolved.
 */
export class SubjectIndex {
  private readonly bySubject = new Map<string, Set<string>>();
  private readonly byExecution = new Map<string, string>();

  constructor(private readonly subjectOf: SubjectResolver) {}

  /** Fold a full event array into a fresh index (deterministic rebuild from the log). */
  static fromEvents(events: readonly EventEnvelope[], subjectOf: SubjectResolver): SubjectIndex {
    const index = new SubjectIndex(subjectOf);
    for (const event of events) index.handleEvent(event);
    return index;
  }

  /** Record the subject an event concerns. Idempotent per execution (O(1) once mapped). */
  handleEvent(event: EventEnvelope): void {
    // Already mapped this execution — the subject is stable, nothing to do.
    if (this.byExecution.has(event.executionId)) return;
    const subjectId = this.subjectOf(event);
    if (subjectId === undefined) return;
    this.byExecution.set(event.executionId, subjectId);
    let set = this.bySubject.get(subjectId);
    if (set === undefined) {
      set = new Set();
      this.bySubject.set(subjectId, set);
    }
    set.add(event.executionId);
  }

  /** The executions concerning a subject (empty if unknown). Sorted for deterministic output. */
  executionsOf(subjectId: string): string[] {
    const set = this.bySubject.get(subjectId);
    return set === undefined ? [] : [...set].sort();
  }

  /** The subject an execution concerns, or `undefined` if none was resolved. */
  subjectOfExecution(executionId: string): string | undefined {
    return this.byExecution.get(executionId);
  }

  /** Whether the index has any records for a subject. */
  has(subjectId: string): boolean {
    return this.bySubject.has(subjectId);
  }

  /** All known subject ids (sorted). The inventory backbone for a compliance report. */
  subjects(): string[] {
    return [...this.bySubject.keys()].sort();
  }

  /** Number of distinct subjects indexed. */
  get size(): number {
    return this.bySubject.size;
  }
}
