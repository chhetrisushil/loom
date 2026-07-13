import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "./types";

// The tenant/execution key separator — a control char that can't appear in a
// normal executionId, so prefixing is unambiguous and un-stripping is exact.
const SEP = ":"; // ":" is not in the ULID alphabet — an unambiguous, collision-free tenant separator

/**
 * K12.5 — a tenant-scoped view of a shared {@link EventStore}. Every execution
 * id is key-prefixed with the tenant on the way in and un-prefixed on the way
 * out, so a store scoped to tenant A can only ever ADDRESS keys under A —
 * reading or subscribing to tenant B's executions is impossible **by
 * construction**, not by a filter that could be bypassed. The app sees its own
 * unprefixed ids throughout (append/read/subscribe/fork all round-trip).
 *
 * Default scoping mechanism per the amendment (A7): key-prefixing. Postgres
 * row-level security is an optional hardening layer on top, not a replacement.
 */
export class TenantScopedEventStore implements EventStore {
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;

  constructor(
    private readonly inner: EventStore,
    private readonly tenant: string
  ) {
    const scope = (id: string): string => `${this.tenant}${SEP}${id}`;
    if (inner.readRange !== undefined) {
      this.readRange = (id, from, to) =>
        inner.readRange!(scope(id), from, to).then((evs) => evs.map((e) => this.unscope(e)));
    }
    if (inner.acquireFence !== undefined) {
      this.acquireFence = (id) => inner.acquireFence!(scope(id));
    }
    if (inner.copyPrefix !== undefined) {
      // Fork stays IN-TENANT: both ids are scoped, so a fork can never cross the
      // tenant boundary (a cross-tenant copy is unaddressable here).
      this.copyPrefix = (from, to, through, metadata) =>
        inner.copyPrefix!(scope(from), scope(to), through, metadata);
    }
    if (inner.deleteExecution !== undefined) {
      this.deleteExecution = (id) => inner.deleteExecution!(scope(id));
    }
    if (inner.truncatePrefix !== undefined) {
      this.truncatePrefix = (id, through) => inner.truncatePrefix!(scope(id), through);
    }
    if (inner.listExecutions !== undefined) {
      // Enumerate only THIS tenant's executions: keep the ones under our prefix, strip it.
      // Cross-tenant ids are invisible (isolation by construction, K12.5).
      const prefix = `${this.tenant}${SEP}`;
      this.listExecutions = async () =>
        (await inner.listExecutions!())
          .filter((id) => id.startsWith(prefix))
          .map((id) => id.slice(prefix.length));
    }
  }

  private scope(id: string): string {
    return `${this.tenant}${SEP}${id}`;
  }

  /** Rewrite a stored envelope's scoped executionId/id back to the app's view. */
  private unscope(e: EventEnvelope): EventEnvelope {
    const prefix = `${this.tenant}${SEP}`;
    if (!e.executionId.startsWith(prefix)) return e;
    const executionId = e.executionId.slice(prefix.length);
    return { ...e, executionId, id: e.id.startsWith(prefix) ? e.id.slice(prefix.length) : e.id };
  }

  /** Prefix an envelope for storage under the tenant scope. */
  private scopeEnvelope(e: EventEnvelope): EventEnvelope {
    return { ...e, executionId: this.scope(e.executionId), id: this.scope(e.id) };
  }

  async append(envelope: EventEnvelope): Promise<void> {
    return this.inner.append(this.scopeEnvelope(envelope));
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    return (await this.inner.read(this.scope(executionId))).map((e) => this.unscope(e));
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return (await this.inner.readFrom(this.scope(executionId), fromSequence)).map((e) =>
      this.unscope(e)
    );
  }

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    return this.inner.subscribe(this.scope(executionId), (e) => handler(this.unscope(e)));
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
