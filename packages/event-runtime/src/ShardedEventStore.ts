import type { EventEnvelope } from "@loom/core";
import type { ShardPlan } from "./ShardPlan";
import { bucketOf } from "./SubscriberRegistry";
import { compareExecutionIds } from "./executionIdOrder";
import { type DecoratorPlan, installOptional } from "./installOptional";
import {
  type EventStore,
  type ExecutionPage,
  OPTIONAL_EVENT_STORE_METHODS,
  type OptionalEventStoreMethod,
  type SealingCapability,
  appendBatchOf,
  headOf,
} from "./types";

export interface ShardedEventStoreOptions {
  /**
   * Which shard owns an execution, when no {@link ShardedEventStoreOptions.plan} is given.
   * Must be STABLE across processes and restarts — two nodes disagreeing routes the same
   * execution to two logs. Default: FNV-1a over the id.
   */
  shardOf?: (executionId: string, shards: number) => number;
  /**
   * An explicit bucket→shard map (ADR 0075). **Required to rebalance**: without it, routing
   * is `hash(id) % shardCount` and changing the shard count silently re-routes almost every
   * execution to a shard that has never seen its data.
   *
   * Omitting it keeps the pre-0075 routing exactly, so existing deployments are unaffected
   * — but they cannot change shard count without moving everything. Start with a plan if
   * you expect to grow.
   */
  plan?: ShardPlan;
  /**
   * How many execution→shard resolutions to remember while buckets are migrating. Bounded
   * so a long-lived store cannot grow without limit. Default 10,000.
   */
  placementCacheSize?: number;
}

/** Result of moving one execution between shards. */
export interface MigrationResult {
  executionId: string;
  /** `moved` — copied then removed from the source. `already-there` — nothing to do. */
  outcome: "moved" | "already-there" | "not-migrating";
  events: number;
}

/**
 * Routes each execution to one of N inner stores (ADR 0074 D3), with support for moving
 * buckets between shards without downtime (ADR 0075).
 *
 * This is the item that needs **zero backend cooperation**: it takes `EventStore[]` and
 * never asks what it is wrapping, so a bring-your-own backend gets the horizontal-scale
 * story free, and the shards may be heterogeneous.
 *
 * ## Routing
 *
 * With a {@link ShardPlan}, executions hash to a virtual bucket and buckets map to shards
 * by an explicit table. Without one, routing is `hash(id) % shardCount` — identical to
 * pre-0075 behaviour, and **not rebalanceable**.
 *
 * ## Rebalancing
 *
 * `plan.rebalanced(n)` marks every bucket whose owner changes as `migrating(from → to)`.
 * That is a routing change only; **no data moves**. For a migrating bucket the store
 * resolves per execution which side actually holds it (one bounded point-read, then
 * cached), so:
 *
 * - executions already on the source keep being read and written there — nothing breaks;
 * - executions that do not exist yet start on the destination.
 *
 * A bucket therefore **drains on its own** as executions complete and retention reclaims
 * them: no copying, no downtime, no coordinator. When you want convergence sooner, or a
 * source shard must be decommissioned, {@link migrateExecution} moves one explicitly. Once
 * {@link isBucketDrained} reports true, `plan.settled(bucket)` retires the extra lookup.
 *
 * ## What this does NOT do
 *
 * - **It does not move a live execution safely.** `migrateExecution` copies then deletes;
 *   an append arriving mid-move lands on the source and is dropped by the delete. Move
 *   terminal executions, or ones you know are not dispatched. The lazy drain above exists
 *   precisely so you rarely need to.
 * - **Fence state does not travel.** The SPI exposes `acquireFence` but no way to read or
 *   write a fence, so a migrated execution arrives unfenced on its destination and a zombie
 *   writer holding an old token could write there. Fence-sensitive deployments should
 *   migrate only executions that are terminal *and* undispatched.
 *
 * Invariants relied on throughout: an execution lives entirely on one shard at any moment,
 * and a stream that exists has a head — which is what makes "which side holds it?" a single
 * indexed point-read (the HEAD, not sequence 0: an inbox topic stream or a floor-seeded stream has
 * no sequence 0).
 */
/**
 * The optional-capability surface EVERY shard shares: an object carrying each optional
 * `EventStore` method that all shards implement (bound to the first shard, so it is a real
 * method, never a stub) and nothing else. Used as the `inner` of `installOptional`, whose
 * rule is "install a method iff the inner store has it" — for a sharded store, "has it" means
 * every shard has it. O(shards × optional methods), once, at construction.
 */
function commonOptional(shards: readonly EventStore[]): EventStore {
  const surface: Partial<Record<OptionalEventStoreMethod, unknown>> = {};
  const first = shards[0] as EventStore;
  for (const method of OPTIONAL_EVENT_STORE_METHODS) {
    if (shards.every((s) => typeof s[method] === "function")) {
      surface[method] = (first[method] as (...a: unknown[]) => unknown).bind(first);
    }
  }
  // ADR 0130 D7/D8 exception: `sealingCapability` is offered when ANY shard has it, because a shard
  // lacking the method seals nothing and must be judged (commonSealing), not silently hide a sealing
  // shard by making the whole store look like it does not seal.
  if (shards.some((s) => typeof s.sealingCapability === "function")) {
    surface.sealingCapability = () => undefined;
  }
  return surface as unknown as EventStore;
}

/**
 * ADR 0129 — an incarnation counter is per shard, so the same number can be issued by two shards
 * (a migrating bucket re-creates an id on another shard). The anchor this store hands out is
 * therefore `s<shardIndex>/<inner anchor>`: it starts with a letter, so it can collide neither
 * with a bare incarnation (digits) nor with the legacy `<timestamp>:<id>` marker (digits first),
 * and an observation taken on one shard never equals the anchor of another.
 */
/**
 * ADR 0130 residuals D7/D8: the shards of one store disagree about sealing (some seal and some do
 * not, or they seal different paths or with different ciphers). Misconfiguration, raised live on
 * every `sealingCapability()` call and never papered over, because one answer serves two questions
 * that must not diverge: "what can this node open" (D7) and "does this store seal at all" (D8, a
 * non-empty `covers`). Carries each shard's cipher and covers, never key material.
 */
export class ShardSealingMismatchError extends Error {
  readonly code = "SHARD_SEALING_MISMATCH";
  readonly shards: readonly {
    readonly index: number;
    readonly cipher: string | undefined;
    readonly covers: readonly string[] | undefined;
  }[];
  constructor(caps: readonly (SealingCapability | undefined)[]) {
    const shards = caps.map((c, index) => ({
      index,
      cipher: c?.cipher,
      covers: c === undefined ? undefined : [...c.covers],
    }));
    super(
      `shards disagree about sealing (${shards
        .map(
          (x) =>
            `#${x.index}: ${x.cipher === undefined ? "none" : `${x.cipher} [${x.covers?.join(", ")}]`}`
        )
        .join("; ")}); every shard must seal the same paths with the same cipher, or none may seal`
    );
    this.name = "ShardSealingMismatchError";
    this.shards = shards;
  }
}

/**
 * The sealing capability of a fleet of shards, FAIL CLOSED: no shard seals -> undefined; every shard
 * reports the same cipher and the same covers -> that capability (`opens` needs every shard to
 * agree); anything else throws {@link ShardSealingMismatchError}.
 */
function commonSealing(
  caps: readonly (SealingCapability | undefined)[]
): SealingCapability | undefined {
  const first = caps[0];
  if (caps.every((c) => c === undefined)) return undefined;
  if (first === undefined) throw new ShardSealingMismatchError(caps);
  const covers = new Set(first.covers);
  const all: SealingCapability[] = [];
  for (const c of caps) {
    if (c === undefined || c.cipher !== first.cipher || !sameSet(covers, c.covers)) {
      throw new ShardSealingMismatchError(caps);
    }
    all.push(c);
  }
  return {
    cipher: first.cipher,
    covers: first.covers,
    opens: (marker) => all.every((c) => c.opens(marker)),
  };
}

/** `covers` is a set of paths: order and duplicates carry no meaning, so compare as sets. */
function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  const bs = new Set(b);
  return bs.size === a.size && [...bs].every((e) => a.has(e));
}

const shardAnchor = (shard: number, inner: string): string => `s${shard}/${inner}`;
/** The inner anchor if `anchor` was issued by `shard`; otherwise the string unchanged, which no
 * inner store can have issued (it starts with `s`), so the shard answers `moved`. */
const unshardAnchor = (anchor: string, shard: number): string => {
  const prefix = `s${shard}/`;
  return anchor.startsWith(prefix) ? anchor.slice(prefix.length) : anchor;
};

export class ShardedEventStore implements EventStore {
  readonly head?: NonNullable<EventStore["head"]>;
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly acquireFenceIf?: NonNullable<EventStore["acquireFenceIf"]>;
  readonly appendIfUnchanged?: NonNullable<EventStore["appendIfUnchanged"]>;
  readonly storeNow?: NonNullable<EventStore["storeNow"]>;
  readonly sealingCapability?: NonNullable<EventStore["sealingCapability"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly truncatePrefixKeeping?: NonNullable<EventStore["truncatePrefixKeeping"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;
  readonly listExecutionsPage?: NonNullable<EventStore["listExecutionsPage"]>;

  private readonly shards: readonly EventStore[];
  private readonly shardOf: (executionId: string, shards: number) => number;
  private plan: ShardPlan | undefined;
  private readonly cacheLimit: number;
  /** executionId → shard, only for executions in migrating buckets. Insertion-ordered LRU. */
  private readonly placementCache = new Map<string, number>();

  constructor(shards: readonly EventStore[], options: ShardedEventStoreOptions = {}) {
    if (shards.length === 0) throw new Error("ShardedEventStore requires at least one shard");
    this.shards = shards;
    this.shardOf = options.shardOf ?? bucketOf;
    this.cacheLimit = Math.max(1, options.placementCacheSize ?? 10_000);
    if (options.plan !== undefined) this.setPlan(options.plan);

    // Optional capabilities are exposed only when EVERY shard has them: a partial
    // capability would work for some executions and not others depending on where they
    // hashed, which is worse than not advertising it at all. `appendBatch` and `copyPrefix`
    // are this class's own methods (they split by shard, and fall back per shard), so the
    // plan covers every other optional method — a new one is a compile error here too.
    type Routed = Exclude<OptionalEventStoreMethod, "appendBatch" | "copyPrefix">;
    const plan = {
      head: async (id) => (await this.route(id)).head!(id),
      readRange: async (id, from, to) => (await this.route(id)).readRange!(id, from, to),
      acquireFence: async (id) => (await this.route(id)).acquireFence!(id),
      acquireFenceIf: async (id, expect) => (await this.route(id)).acquireFenceIf!(id, expect),
      appendIfUnchanged: async (id, event, expect) => {
        const i = await this.routeIndex(id);
        const shard = this.shards[i] as EventStore;
        const result = await shard.appendIfUnchanged!(
          id,
          event,
          expect === undefined ? undefined : { ...expect, anchor: unshardAnchor(expect.anchor, i) }
        );
        return "anchor" in result && typeof result.anchor === "string"
          ? { ...result, anchor: shardAnchor(i, result.anchor) }
          : result;
      },
      // One clock for the fleet: every shard has it (commonOptional), read from the first shard.
      storeNow: "forward",
      // ADR 0130 residuals D7/D8: a stream may sit on any shard, so shards must agree. Installed when
      // ANY shard has the method (commonOptional); a shard lacking it counts as sealing nothing
      // (undefined). Fails closed (ShardSealingMismatchError) on any disagreement, so "can open" and
      // "does seal" cannot diverge. When no shard has it the method is omitted.
      sealingCapability: () => commonSealing(this.shards.map((s) => s.sealingCapability?.())),
      deleteExecution: async (id) => {
        await (await this.route(id)).deleteExecution!(id);
        this.placementCache.delete(id);
      },
      truncatePrefix: async (id, through) => (await this.route(id)).truncatePrefix!(id, through),
      truncatePrefixKeeping: async (id, through, keep) =>
        (await this.route(id)).truncatePrefixKeeping!(id, through, keep),
      listExecutions: async () => {
        const perShard = await Promise.all(this.shards.map((s) => s.listExecutions!()));
        // Dedupe: a crash between migrateExecution's copy and delete can leave an execution
        // on both sides, and enumeration must still report it once.
        return [...new Set(perShard.flat())];
      },
      // Paged enumeration needs EVERY shard to be pageable; falling back to listExecutions
      // on some would defeat the bounded-memory guarantee the page API exists to provide.
      listExecutionsPage: (opts) => this.pagedScatterGather(opts),
    } satisfies DecoratorPlan<EventStore, Routed>;
    // `installOptional` installs a method iff its `inner` has it; here "inner" is the
    // capability surface every shard shares.
    installOptional<EventStore, Routed>(this, commonOptional(shards), plan);
    // The structural encryption marker (`keys`, see `installOptional`) must survive sharding,
    // or `Sharded(Encrypting(pg)…)` — the ADR 0074 composition — would look like a plain store
    // to LogLifecycle's compaction/archive guard and to `loom doctor`. Carried up when every
    // shard shares ONE KeyStore; shards that disagree (or only some encrypting) get a marker
    // no snapshot store can match, so the guard fails closed rather than guessing.
    const markers = shards.map((s) => (s as { keys?: unknown }).keys);
    if (markers.some((k) => typeof k === "object" && k !== null)) {
      const first = markers[0];
      (this as { keys?: unknown }).keys = markers.every((k) => k === first)
        ? first
        : Object.freeze({ mixed: true });
    }
  }

  /**
   * Install a new routing plan — how a rebalance is applied, and how a drained bucket is
   * settled. **Every node sharing the log must converge on the same plan**; different plans
   * on different nodes split the log.
   */
  setPlan(plan: ShardPlan): void {
    if (plan.shardCount !== this.shards.length) {
      throw new Error(
        `plan expects ${plan.shardCount} shards but the store has ${this.shards.length}`
      );
    }
    this.plan = plan;
    // Cached placements were resolved against the previous plan; a bucket that settled or
    // started migrating invalidates them.
    this.placementCache.clear();
  }

  /** The active plan, if routing is plan-driven. */
  get shardPlan(): ShardPlan | undefined {
    return this.plan;
  }

  /** Resolve the store owning `executionId` right now. */
  private async route(executionId: string): Promise<EventStore> {
    return this.shards[await this.routeIndex(executionId)] as EventStore;
  }

  private async routeIndex(executionId: string): Promise<number> {
    if (this.plan === undefined) {
      return this.shardOf(executionId, this.shards.length);
    }
    const placement = this.plan.placementFor(executionId);
    if (placement.kind === "settled") return placement.shard;

    const cached = this.placementCache.get(executionId);
    if (cached !== undefined) {
      // Refresh recency (Map preserves insertion order, so re-insert moves it to the end).
      this.placementCache.delete(executionId);
      this.placementCache.set(executionId, cached);
      return cached;
    }

    // Which side actually holds it? Sequence 0 is the bootstrap anchor: present for as long
    // as the execution exists (truncatePrefix preserves it, deleteExecution removes it), so
    // one indexed point-read answers the question. The destination is checked FIRST, so a
    // migrated execution stops consulting the source immediately — and so a crash between
    // copy and delete resolves to the destination, which is the surviving copy.
    // The probe is the stream HEAD (one indexed MAX(sequence)), not sequence 0: a stream that never
    // had a sequence 0 (an inbox topic stream starts at 2^40; a legacy inbox stream seeded at a fork
    // floor starts above 0) is on a shard all the same, and a probe of 0 would route it to the
    // destination while its data (and the owner's cursor) sit on the source.
    const onTo = await headOf(this.shards[placement.to] as EventStore, executionId);
    if (onTo !== null) return this.remember(executionId, placement.to);
    const onFrom = await headOf(this.shards[placement.from] as EventStore, executionId);
    if (onFrom !== null) return this.remember(executionId, placement.from);
    // Unknown to both ⇒ it does not exist yet, so it belongs to the destination. Caching
    // that is what makes a new execution's subsequent appends single-lookup.
    return this.remember(executionId, placement.to);
  }

  private remember(executionId: string, shard: number): number {
    this.placementCache.set(executionId, shard);
    if (this.placementCache.size > this.cacheLimit) {
      const oldest = this.placementCache.keys().next();
      if (!oldest.done) this.placementCache.delete(oldest.value);
    }
    return shard;
  }

  /**
   * Move one execution from a migrating bucket's source to its destination: copy every
   * event, then delete the source copy.
   *
   * **The caller must ensure the execution is not being written concurrently** — an append
   * arriving mid-move lands on the source and is then deleted. Terminal executions are the
   * safe case, and the lazy drain described on the class means you usually do not need this
   * at all; reach for it when a source shard must be decommissioned.
   *
   * Fence state does not move (the SPI has no way to read it), so the execution arrives
   * unfenced on the destination.
   */
  async migrateExecution(executionId: string): Promise<MigrationResult> {
    if (this.plan === undefined) return { executionId, outcome: "not-migrating", events: 0 };
    const placement = this.plan.placementFor(executionId);
    if (placement.kind === "settled") return { executionId, outcome: "not-migrating", events: 0 };

    const current = await this.routeIndex(executionId);
    if (current === placement.to) return { executionId, outcome: "already-there", events: 0 };

    const source = this.shards[placement.from] as EventStore;
    const target = this.shards[placement.to] as EventStore;
    const events = await source.read(executionId);
    if (events.length > 0) await appendBatchOf(target, events);
    // Copy BEFORE delete. A crash in between leaves the execution on both sides, which
    // `routeIndex` resolves to the destination (checked first) and a re-run cleans up. The
    // reverse order would lose the log outright.
    await source.deleteExecution?.(executionId);
    this.placementCache.delete(executionId);
    this.remember(executionId, placement.to);
    return { executionId, outcome: "moved", events: events.length };
  }

  /**
   * Whether a migrating bucket's source side still holds anything — i.e. whether
   * `plan.settled(bucket)` is safe yet. `true` for a settled bucket (nothing to drain).
   *
   * Requires enumerable shards.
   */
  async isBucketDrained(bucket: number): Promise<boolean> {
    const plan = this.plan;
    if (plan === undefined) return true;
    const placement = plan.placementAt(bucket);
    if (placement.kind === "settled") return true;
    const source = this.shards[placement.from] as EventStore;
    if (source.listExecutions === undefined) {
      throw new Error("isBucketDrained needs shards that support listExecutions()");
    }
    const ids = await source.listExecutions();
    return !ids.some((id) => plan.bucketFor(id) === bucket);
  }

  async append(envelope: EventEnvelope): Promise<void> {
    return (await this.route(envelope.executionId)).append(envelope);
  }

  /**
   * Split a batch by shard and append each part. Shards are independent logs, so the parts
   * run concurrently.
   *
   * Atomicity is per shard, which is exactly what the SPI requires: the contract is atomic
   * PER EXECUTION, and an execution never spans shards. Whole-batch atomicity across
   * shards would need a distributed transaction, costs far more than batching saves, and
   * nothing needs it — a batch only groups INDEPENDENT executions, so nothing in it
   * depends on anything else in it. `Promise.all` rejects if any shard does, so a caller
   * still never reads a partial write as success.
   */
  async appendBatch(envelopes: readonly EventEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return;
    const slots = await Promise.all(envelopes.map((e) => this.routeIndex(e.executionId)));
    const bySlot = new Map<number, EventEnvelope[]>();
    for (const [i, envelope] of envelopes.entries()) {
      const slot = slots[i] as number;
      const list = bySlot.get(slot);
      if (list === undefined) bySlot.set(slot, [envelope]);
      else list.push(envelope);
    }
    await Promise.all(
      [...bySlot].map(([slot, part]) => appendBatchOf(this.shards[slot] as EventStore, part))
    );
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    return (await this.route(executionId)).read(executionId);
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return (await this.route(executionId)).readFrom(executionId, fromSequence);
  }

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    return (await this.route(executionId)).subscribe(executionId, handler);
  }

  /**
   * Fork. Fast when parent and child resolve to the same shard; otherwise the prefix has to
   * cross a store boundary, so we use the SPI's documented per-event fallback.
   */
  async copyPrefix(
    fromExecutionId: string,
    toExecutionId: string,
    throughSequence: number,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const source = await this.route(fromExecutionId);
    const target = await this.route(toExecutionId);
    if (source === target && source.copyPrefix !== undefined) {
      return source.copyPrefix(fromExecutionId, toExecutionId, throughSequence, metadata);
    }
    const events = await source.read(fromExecutionId);
    const copied = events
      .filter((e) => e.sequence <= throughSequence)
      .map((e) => ({
        ...e,
        id: `${toExecutionId}-${e.sequence}`,
        executionId: toExecutionId,
        metadata: { ...e.metadata, ...metadata },
      }));
    await appendBatchOf(target, copied);
  }

  /**
   * Keyset pagination across shards. Each shard is asked for its next page beyond the
   * cursor; the results are merged and truncated to `limit`, so the caller sees one
   * globally ordered stream and the cursor stays a single id.
   *
   * Correct ONLY because every shard pages in the SPI's one order (code point, SPI 2.0.0)
   * and accepts any id as a cursor: the merged page's last id is handed back to EVERY shard,
   * including shards that never returned it. A shard paging in another order (a Postgres
   * database collation, before L10) skips the ids that sort after the cursor in one order
   * and before it in the other — silently, since every page still looks well-formed.
   *
   * Deduplicated for the same reason as `listExecutions`: mid-migration an execution can
   * briefly exist on two shards.
   */
  private async pagedScatterGather(opts?: {
    cursor?: string;
    limit?: number;
  }): Promise<ExecutionPage> {
    const limit = opts?.limit ?? 1000;
    const pages = await Promise.all(
      this.shards.map((s) =>
        s.listExecutionsPage!({ ...(opts?.cursor !== undefined && { cursor: opts.cursor }), limit })
      )
    );
    const union = new Set(pages.flatMap((p) => p.executionIds));
    const merged = [...union].sort(compareExecutionIds).slice(0, limit);
    const last = merged[merged.length - 1];
    // More remains if any shard reported a further page, or if the merge itself truncated.
    const truncated = pages.some((p) => p.nextCursor !== undefined) || union.size > merged.length;
    return {
      executionIds: merged,
      ...(truncated && last !== undefined && { nextCursor: last }),
    };
  }

  async close(): Promise<void> {
    await Promise.all(this.shards.map((s) => s.close()));
  }
}
