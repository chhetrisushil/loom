import type { EventEnvelope } from "@loom/core";
import { type DecoratorPlan, installOptional } from "./installOptional";
import type { EventStore, ExecutionPage, OptionalEventStoreMethod } from "./types";

// The tenant/execution key separator — a control char that can't appear in a
// normal executionId, so prefixing is unambiguous and un-stripping is exact.
const SEP = ":"; // ":" is not in the ULID alphabet — an unambiguous, collision-free tenant separator

/**
 * One tenant's page of a shared store's keyset-paged enumeration.
 *
 * The inner cursor is opaque, so there is no seek to the tenant's range: this pages the inner
 * store, keeps the ids under `prefix` (stripped), and loops until a page yields at least one
 * id or the inner store is exhausted. It passes the inner cursor through unchanged, so the
 * next call resumes exactly where this one stopped.
 *
 * It deliberately does NOT stop at the first id that sorts past the prefix. That shortcut is
 * sound only if ids sharing a prefix are contiguous, i.e. strict code-unit order — and the
 * Postgres backend pages in the database's collation, where `"a~"` sorts before `"ab"`
 * (measured on a PG 17 `en_US.UTF-8` cluster). A missed id here is a silent partial pass:
 * retention skips an execution, a read model under-indexes. So the cost is O(ids in the
 * store) per full pass — what the whole-list fallback cost before — in bounded memory (one
 * inner page), and correct under any order a store returns.
 */
async function pageWithinPrefix(
  inner: EventStore,
  prefix: string,
  opts: { cursor?: string; limit?: number } | undefined
): Promise<ExecutionPage> {
  let cursor = opts?.cursor;
  for (;;) {
    const page = await inner.listExecutionsPage!({
      ...(cursor !== undefined && { cursor }),
      ...(opts?.limit !== undefined && { limit: opts.limit }),
    });
    const executionIds: string[] = [];
    for (const id of page.executionIds) {
      if (id.startsWith(prefix)) executionIds.push(id.slice(prefix.length));
    }
    if (page.nextCursor === undefined) return { executionIds };
    if (executionIds.length > 0) return { executionIds, nextCursor: page.nextCursor };
    if (page.nextCursor === cursor) {
      // The same guard `iterateExecutionIds` applies — except this loop is internal, so
      // without it a store bug would spin here where no caller could see it.
      throw new TypeError(
        "TenantScopedEventStore: listExecutionsPage returned a non-advancing cursor (store bug)"
      );
    }
    cursor = page.nextCursor;
  }
}

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
  readonly appendBatch?: NonNullable<EventStore["appendBatch"]>;
  readonly head?: NonNullable<EventStore["head"]>;
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;
  readonly listExecutionsPage?: NonNullable<EventStore["listExecutionsPage"]>;

  constructor(
    private readonly inner: EventStore,
    private readonly tenant: string
  ) {
    const scope = (id: string): string => `${this.tenant}${SEP}${id}`;
    const prefix = `${this.tenant}${SEP}`;
    // Every optional method decided here, over the whole union (ADR 0074 Amendment): a new
    // SPI method is a compile error until this decorator forwards, overrides or refuses it.
    const plan = {
      // Order preserved: the SPI's per-execution order is array order.
      appendBatch: (envs) => inner.appendBatch!(envs.map((e) => this.scopeEnvelope(e))),
      head: (id) => inner.head!(scope(id)),
      readRange: (id, from, to) =>
        inner.readRange!(scope(id), from, to).then((evs) => evs.map((e) => this.unscope(e))),
      acquireFence: (id) => inner.acquireFence!(scope(id)),
      // Fork stays IN-TENANT: both ids are scoped, so a fork can never cross the
      // tenant boundary (a cross-tenant copy is unaddressable here).
      copyPrefix: (from, to, through, metadata) =>
        inner.copyPrefix!(scope(from), scope(to), through, metadata),
      deleteExecution: (id) => inner.deleteExecution!(scope(id)),
      truncatePrefix: (id, through) => inner.truncatePrefix!(scope(id), through),
      // Enumerate only THIS tenant's executions: keep the ones under our prefix, strip it.
      // Cross-tenant ids are invisible (isolation by construction, K12.5).
      listExecutions: async () =>
        (await inner.listExecutions!())
          .filter((id) => id.startsWith(prefix))
          .map((id) => id.slice(prefix.length)),
      listExecutionsPage: (opts) => pageWithinPrefix(inner, prefix, opts),
    } satisfies DecoratorPlan<EventStore, OptionalEventStoreMethod>;
    installOptional<EventStore, OptionalEventStoreMethod>(this, inner, plan);
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
