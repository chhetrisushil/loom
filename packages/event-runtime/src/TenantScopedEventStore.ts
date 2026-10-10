import type { EventEnvelope } from "@loom/core";
import { compareExecutionIds } from "./executionIdOrder";
import { StaleFenceError } from "./fencing";
import { type DecoratorPlan, installOptional } from "./installOptional";
import type { EventStore, ExecutionPage, OptionalEventStoreMethod } from "./types";
import { DuplicateEnvelopeIdError, DuplicateSequenceError } from "./writeConflicts";

// The tenant/execution key separator — a control char that can't appear in a
// normal executionId, so prefixing is unambiguous and un-stripping is exact.
const SEP = ":"; // ":" is not in the ULID alphabet — an unambiguous, collision-free tenant separator

/**
 * One tenant's page of a shared store's keyset-paged enumeration.
 *
 * The cursor is an OUTER id — this tenant's unprefixed executionId — because that is what a
 * caller holds: `ShardedEventStore` (the ADR 0074 composition, sharding outermost) resumes
 * every shard from the last id of its MERGED page, which it only ever sees unprefixed. Before
 * L10 this passed the inner, prefixed cursor out, and got the unprefixed one back in, so
 * `Sharded(TenantScoped(…))` compared `e-04` against `acme:e-…` and re-served its first page
 * forever.
 *
 * Since EventStore SPI 2.0.0 every store pages in code point order, where the ids under
 * `prefix` are CONTIGUOUS. So a page seeks to the tenant (the empty id `prefix` included —
 * a blank stream is still this tenant's, and repair must be able to find it) and stops at
 * the first id past the prefix, instead of walking the whole shared store. The cursor is
 * exclusive, so a fresh scan cannot start AT `prefix`; it starts at {@link seekBelow}, the
 * largest practical string below `prefix` (`acme9\u{10FFFF}` for `acme:`): every other
 * tenant whose name extends this one with a character below `:` (`acme-eu`, `acme.io`,
 * `acme0`…`acme9`) sorts before it and is never read.
 *
 * It does not stop early with an empty page and a cursor: a non-final page with no ids is not
 * something consumers are written for (`ShardedEventStore` reads an empty merged page as the
 * end). Memory stays one inner page.
 */
/**
 * The exclusive cursor a fresh tenant scan starts from: `SEP` is `:` (U+003A), so the string
 * just below `tenant + ":"` is `tenant + "9"` (U+0039) followed by the highest code point.
 * Only an id that continues past `tenant + "9\u{10FFFF}"` (never produced by an id
 * generator) could sit between it and the tenant's range, and would be walked and dropped.
 * The tenant's blank stream (`tenant + ":"`) sorts after it, so repair still finds it.
 */
function seekBelow(tenant: string): string {
  return `${tenant}9\u{10FFFF}`;
}

async function pageWithinPrefix(
  inner: EventStore,
  tenant: string,
  prefix: string,
  opts: { cursor?: string; limit?: number } | undefined
): Promise<ExecutionPage> {
  let cursor = opts?.cursor === undefined ? seekBelow(tenant) : `${prefix}${opts.cursor}`;
  for (;;) {
    const page = await inner.listExecutionsPage!({
      cursor,
      ...(opts?.limit !== undefined && { limit: opts.limit }),
    });
    const executionIds: string[] = [];
    let pastPrefix = false;
    for (const id of page.executionIds) {
      if (id.startsWith(prefix)) executionIds.push(id.slice(prefix.length));
      // Every id after the tenant's range sorts after `prefix` without starting with it.
      else if (compareExecutionIds(id, prefix) > 0) {
        pastPrefix = true;
        break;
      }
    }
    const last = executionIds[executionIds.length - 1];
    if (pastPrefix || page.nextCursor === undefined) return { executionIds };
    if (last !== undefined) return { executionIds, nextCursor: last };
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
  readonly acquireFenceIf?: NonNullable<EventStore["acquireFenceIf"]>;
  readonly appendIfUnchanged?: NonNullable<EventStore["appendIfUnchanged"]>;
  readonly storeNow?: NonNullable<EventStore["storeNow"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly truncatePrefixKeeping?: NonNullable<EventStore["truncatePrefixKeeping"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;
  readonly listExecutionsPage?: NonNullable<EventStore["listExecutionsPage"]>;

  constructor(
    private readonly inner: EventStore,
    private readonly tenant: string
  ) {
    if (tenant === "" || tenant.includes(SEP)) {
      // Prefix scoping is only isolation if no tenant's prefix is a prefix of another's:
      // tenant "a" scopes "b:x" to "a:b:x", which is tenant "a:b"'s "x".
      throw new TypeError(
        `TenantScopedEventStore: tenant must be non-empty and must not contain the separator "${SEP}" (got ${JSON.stringify(tenant)})`
      );
    }
    const scope = (id: string): string => `${this.tenant}${SEP}${id}`;
    const prefix = `${this.tenant}${SEP}`;
    // Every optional method decided here, over the whole union (ADR 0074 Amendment): a new
    // SPI method is a compile error until this decorator forwards, overrides or refuses it.
    const plan = {
      // Order preserved: the SPI's per-execution order is array order.
      appendBatch: (envs) =>
        inner.appendBatch!(envs.map((e) => this.scopeEnvelope(e))).catch(this.rethrowUnscoped),
      head: (id) => inner.head!(scope(id)),
      readRange: (id, from, to) =>
        inner.readRange!(scope(id), from, to).then((evs) => evs.map((e) => this.unscope(e))),
      acquireFence: (id) => inner.acquireFence!(scope(id)),
      acquireFenceIf: (id, expect) => inner.acquireFenceIf!(scope(id), expect),
      appendIfUnchanged: (id, event, expect) =>
        inner.appendIfUnchanged!(
          scope(id),
          event === null ? null : this.scopeEnvelope(event),
          expect
        ).catch(this.rethrowUnscoped),
      storeNow: "forward", // the store clock is not tenant data
      // Fork stays IN-TENANT: both ids are scoped, so a fork can never cross the
      // tenant boundary (a cross-tenant copy is unaddressable here).
      copyPrefix: (from, to, through, metadata) =>
        inner.copyPrefix!(scope(from), scope(to), through, metadata).catch(this.rethrowUnscoped),
      deleteExecution: (id) => inner.deleteExecution!(scope(id)),
      truncatePrefix: (id, through) => inner.truncatePrefix!(scope(id), through),
      truncatePrefixKeeping: (id, through, keep) =>
        inner.truncatePrefixKeeping!(scope(id), through, keep),
      // Enumerate only THIS tenant's executions: keep the ones under our prefix, strip it.
      // Cross-tenant ids are invisible (isolation by construction, K12.5).
      listExecutions: async () =>
        (await inner.listExecutions!())
          .filter((id) => id.startsWith(prefix))
          .map((id) => id.slice(prefix.length)),
      listExecutionsPage: (opts) => pageWithinPrefix(inner, this.tenant, prefix, opts),
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
    return this.inner.append(this.scopeEnvelope(envelope)).catch(this.rethrowUnscoped);
  }

  /**
   * L20 — the store's write refusals name the id it WROTE, which is the scoped one (`acme:x`).
   * The app never sees scoped ids anywhere else, and callers key on the refusal's id: a
   * dispatcher decides "another holder owns THIS execution" by comparing it with its own
   * (`isSupersededRefusal`), so a prefixed id made every fenced-out attempt read as a genuine
   * failure and the ping-pong came back under tenancy. The three normalized refusals are
   * re-raised as the same class and name with the ids unscoped and the original as `cause`.
   * Anything else — and a refusal naming another tenant's key, which cannot be unscoped — passes
   * through untouched.
   */
  private readonly rethrowUnscoped = (err: unknown): never => {
    throw this.unscopeError(err);
  };

  private unscopeError(err: unknown): unknown {
    if (err === null || typeof err !== "object") return err;
    const prefix = `${this.tenant}${SEP}`;
    const e = err as Record<string, unknown>;
    const executionId = e.executionId;
    if (typeof executionId !== "string" || !executionId.startsWith(prefix)) return err;
    const id = executionId.slice(prefix.length);
    switch (e.name) {
      case "StaleFenceError":
        return new StaleFenceError(
          id,
          e.staleFence as number | undefined,
          e.currentFence as number,
          err
        );
      case "DuplicateSequenceError":
        return new DuplicateSequenceError(id, e.sequence as number, err);
      case "DuplicateEnvelopeIdError": {
        const envelopeId = String(e.envelopeId);
        return new DuplicateEnvelopeIdError(
          envelopeId.startsWith(prefix) ? envelopeId.slice(prefix.length) : envelopeId,
          id,
          err
        );
      }
      default:
        return err;
    }
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
