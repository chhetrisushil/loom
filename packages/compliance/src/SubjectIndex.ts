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
//
// T3-R2.4 — multi-tenant isolation. In a shared runtime serving several tenants (K12), two
// tenants can legitimately use the SAME subject id ("alice" at tenant A ≠ "alice" at tenant
// B). Merging them would leak one tenant's records into another's access/erasure request —
// a data-protection breach. So the index is PARTITIONED BY TENANT: the app supplies an
// optional `TenantResolver` (the tenant is not in the event by default — principal chains
// are not persisted — so the app reads it from input/metadata), and every query is scoped to
// a tenant. With no resolver, all records fall in one default partition (single-tenant apps
// are unchanged).

/** Given an event, the data subject it concerns — or `undefined` if it names none. */
export type SubjectResolver = (event: EventEnvelope) => string | undefined;

/** Given an event, the tenant it belongs to — or `undefined` for the default partition. */
export type TenantResolver = (event: EventEnvelope) => string | undefined;

/** The partition subjects fall into when no tenant is resolved (single-tenant apps). */
export const DEFAULT_TENANT = "";

export interface SubjectIndexOptions {
  /** Partition the index by tenant (T3-R2.4). Omit for a single-tenant app. */
  tenantOf?: TenantResolver;
}

/**
 * A live, rebuildable index of `(tenant, subjectId) → executionIds`. Feed it the event stream
 * (`handleEvent`, e.g. from `defineConfig`'s `onEvent`) or rebuild from a log
 * ({@link SubjectIndex.fromEvents}) — both yield the same state (P2). Backed by a nested
 * `Map<tenant, Map<subject, Set<execution>>>` for O(1) scoped membership + a reverse
 * `Map<execution, {tenant, subject}>` for O(1) dedupe and lookup, so a burst of events for
 * one execution is not re-resolved and tenants never share a subject bucket.
 */
export class SubjectIndex {
  private readonly byTenant = new Map<string, Map<string, Set<string>>>();
  private readonly byExecution = new Map<string, { tenant: string; subject: string }>();
  private readonly tenantOf: TenantResolver;

  constructor(
    private readonly subjectOf: SubjectResolver,
    options: SubjectIndexOptions = {}
  ) {
    this.tenantOf = options.tenantOf ?? (() => DEFAULT_TENANT);
  }

  /** Fold a full event array into a fresh index (deterministic rebuild from the log). */
  static fromEvents(
    events: readonly EventEnvelope[],
    subjectOf: SubjectResolver,
    options: SubjectIndexOptions = {}
  ): SubjectIndex {
    const index = new SubjectIndex(subjectOf, options);
    for (const event of events) index.handleEvent(event);
    return index;
  }

  /** Record the subject (and tenant) an event concerns. Idempotent per execution (O(1) once mapped). */
  handleEvent(event: EventEnvelope): void {
    // Already mapped this execution — the (tenant, subject) is stable, nothing to do.
    if (this.byExecution.has(event.executionId)) return;
    const subject = this.subjectOf(event);
    if (subject === undefined) return;
    const tenant = this.tenantOf(event) ?? DEFAULT_TENANT;
    this.byExecution.set(event.executionId, { tenant, subject });
    let subjects = this.byTenant.get(tenant);
    if (subjects === undefined) {
      subjects = new Map();
      this.byTenant.set(tenant, subjects);
    }
    let set = subjects.get(subject);
    if (set === undefined) {
      set = new Set();
      subjects.set(subject, set);
    }
    set.add(event.executionId);
  }

  /**
   * The executions concerning a subject WITHIN a tenant (empty if unknown). Sorted for
   * deterministic output. `tenant` defaults to the single partition (single-tenant apps).
   */
  executionsOf(subjectId: string, tenant: string = DEFAULT_TENANT): string[] {
    const set = this.byTenant.get(tenant)?.get(subjectId);
    return set === undefined ? [] : [...set].sort();
  }

  /** The subject an execution concerns, or `undefined` if none was resolved. */
  subjectOfExecution(executionId: string): string | undefined {
    return this.byExecution.get(executionId)?.subject;
  }

  /** The tenant an execution belongs to, or `undefined` if the execution is unknown. */
  tenantOfExecution(executionId: string): string | undefined {
    return this.byExecution.get(executionId)?.tenant;
  }

  /** Whether the index has any records for a subject within a tenant. */
  has(subjectId: string, tenant: string = DEFAULT_TENANT): boolean {
    return this.byTenant.get(tenant)?.has(subjectId) ?? false;
  }

  /** The subjects within a tenant (sorted). The inventory backbone for a compliance report. */
  subjects(tenant: string = DEFAULT_TENANT): string[] {
    const subjects = this.byTenant.get(tenant);
    return subjects === undefined ? [] : [...subjects.keys()].sort();
  }

  /** All tenant ids with any records (sorted). A single-tenant app reports one, `""`. */
  tenants(): string[] {
    return [...this.byTenant.keys()].sort();
  }

  /** Number of distinct (tenant, subject) pairs indexed. */
  get size(): number {
    let total = 0;
    for (const subjects of this.byTenant.values()) total += subjects.size;
    return total;
  }
}
