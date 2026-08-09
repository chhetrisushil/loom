import { bucketOf } from "./SubscriberRegistry";

/**
 * Where a bucket's executions live.
 *
 * `migrating` is the whole point of the plan: a bucket can be *in the process of* moving
 * without anything being blocked or copied, because the store resolves per execution which
 * side actually holds it.
 */
export type ShardPlacement =
  | { readonly kind: "settled"; readonly shard: number }
  | { readonly kind: "migrating"; readonly from: number; readonly to: number };

/** Serialized form. Every node sharing a log MUST load the same plan. */
export interface ShardPlanJSON {
  readonly version: 1;
  readonly shardCount: number;
  readonly placements: ReadonlyArray<{ shard: number } | { from: number; to: number }>;
}

/** Default virtual-bucket count. Power of two, comfortably above any realistic shard count. */
export const DEFAULT_BUCKETS = 4096;

/**
 * An explicit, persistable map from virtual bucket to shard — the thing that makes a
 * sharded log **rebalanceable** (ADR 0075).
 *
 * Without it, routing is `hash(executionId) % shardCount`, and changing the shard count
 * re-routes almost every execution at once: reads land on a shard that has never seen the
 * data. That is not a rebalance, it is data loss with extra steps.
 *
 * Two things fix that, and this class is both:
 *
 * 1. **Virtual buckets.** Executions hash to one of `buckets` (default 4096), and buckets
 *    are assigned to shards by an explicit table. Growing from N to N+1 shards moves
 *    roughly `1/(N+1)` of the buckets instead of nearly all of them.
 * 2. **A `migrating` state per bucket.** A bucket being moved names both sides, so the
 *    store can keep serving reads and writes for executions that still live on the source
 *    while new ones start on the destination.
 *
 * The plan is **immutable** — every mutation returns a new plan. It is a value that
 * multiple nodes must agree on, so it wants to be compared, persisted, and shipped around,
 * not mutated in place.
 */
export class ShardPlan {
  private constructor(
    readonly shardCount: number,
    private readonly placements: readonly ShardPlacement[]
  ) {}

  /** Buckets spread round-robin over `shardCount` shards, all settled. */
  static uniform(shardCount: number, buckets: number = DEFAULT_BUCKETS): ShardPlan {
    if (shardCount < 1) throw new Error("ShardPlan requires at least one shard");
    if (buckets < shardCount) {
      throw new Error(
        `ShardPlan needs at least as many buckets as shards (buckets=${buckets}, shards=${shardCount})`
      );
    }
    return new ShardPlan(
      shardCount,
      Array.from({ length: buckets }, (_, b) => ({ kind: "settled", shard: b % shardCount }))
    );
  }

  static fromJSON(json: ShardPlanJSON): ShardPlan {
    if (json.version !== 1) throw new Error(`unsupported ShardPlan version ${json.version}`);
    const placements = json.placements.map(
      (p): ShardPlacement =>
        "shard" in p
          ? { kind: "settled", shard: p.shard }
          : { kind: "migrating", from: p.from, to: p.to }
    );
    const plan = new ShardPlan(json.shardCount, placements);
    plan.assertValid();
    return plan;
  }

  toJSON(): ShardPlanJSON {
    return {
      version: 1,
      shardCount: this.shardCount,
      placements: this.placements.map((p) =>
        p.kind === "settled" ? { shard: p.shard } : { from: p.from, to: p.to }
      ),
    };
  }

  get buckets(): number {
    return this.placements.length;
  }

  /** No bucket is mid-move. */
  get isStable(): boolean {
    return this.placements.every((p) => p.kind === "settled");
  }

  bucketFor(executionId: string): number {
    return bucketOf(executionId, this.placements.length);
  }

  placementAt(bucket: number): ShardPlacement {
    const placement = this.placements[bucket];
    if (placement === undefined) throw new Error(`bucket ${bucket} is out of range`);
    return placement;
  }

  placementFor(executionId: string): ShardPlacement {
    return this.placementAt(this.bucketFor(executionId));
  }

  /** Buckets currently mid-move, in ascending order. */
  migratingBuckets(): number[] {
    const out: number[] = [];
    for (let b = 0; b < this.placements.length; b++) {
      if ((this.placements[b] as ShardPlacement).kind === "migrating") out.push(b);
    }
    return out;
  }

  /**
   * Re-spread buckets over `shardCount` shards, marking every bucket whose owner changes as
   * `migrating(old → new)`. Nothing is copied — the returned plan is only a routing
   * decision. Executions already on the source keep being served there; new ones start on
   * the destination. See {@link ShardedEventStore.migrateExecution} to actually move data,
   * and {@link settled} to finish a bucket.
   *
   * Refuses to re-plan while a migration is outstanding: layering a second move over an
   * unfinished one would produce a bucket whose executions are spread over three shards,
   * which nothing here can resolve. Settle first.
   */
  rebalanced(shardCount: number, options: { allowShrink?: boolean } = {}): ShardPlan {
    if (shardCount < 1) throw new Error("ShardPlan requires at least one shard");
    if (!this.isStable) {
      throw new Error(
        `cannot rebalance while ${this.migratingBuckets().length} bucket(s) are still migrating — settle them first`
      );
    }
    if (shardCount < this.shardCount && options.allowShrink !== true) {
      throw new Error(
        `rebalancing ${this.shardCount} → ${shardCount} shards removes capacity; pass { allowShrink: true } if that is intended`
      );
    }
    if (this.placements.length < shardCount) {
      throw new Error(
        `ShardPlan needs at least as many buckets as shards (buckets=${this.placements.length}, shards=${shardCount})`
      );
    }

    // MINIMAL MOVEMENT. The naive assignment — `bucket % shardCount` — throws away the
    // existing layout and rehashes everything: measured, growing 4→5 shards moves 80% of
    // buckets and 8→9 moves 89%, which is barely better than the `hash % shardCount`
    // routing virtual buckets exist to escape.
    //
    // Instead: keep every bucket where it is, and move only the EXCESS from shards that now
    // hold more than their fair share onto shards that hold less. That moves ~1/newCount of
    // buckets, which is the theoretical minimum for a uniform target.
    const total = this.placements.length;
    const base = Math.floor(total / shardCount);
    const remainder = total % shardCount;
    // The first `remainder` shards carry one extra bucket, so the targets sum to `total`.
    const targetFor = (shard: number): number => base + (shard < remainder ? 1 : 0);

    const heldBy = new Map<number, number[]>();
    for (const [bucket, placement] of this.placements.entries()) {
      const shard = (placement as { shard: number }).shard;
      const list = heldBy.get(shard);
      if (list === undefined) heldBy.set(shard, [bucket]);
      else list.push(bucket);
    }

    const owner = this.placements.map((p) => (p as { shard: number }).shard);
    const orphans: number[] = [];
    const kept = new Map<number, number>();
    for (const [shard, list] of heldBy) {
      if (shard >= shardCount) {
        // The shard is going away entirely (a shrink); everything it holds must move.
        orphans.push(...list);
        continue;
      }
      const target = targetFor(shard);
      kept.set(shard, Math.min(list.length, target));
      if (list.length > target) orphans.push(...list.slice(target));
    }

    // Vacancies, in shard order, so the assignment is deterministic across nodes.
    const vacancies: number[] = [];
    for (let shard = 0; shard < shardCount; shard++) {
      const have = kept.get(shard) ?? 0;
      for (let i = have; i < targetFor(shard); i++) vacancies.push(shard);
    }
    for (const [i, bucket] of orphans.entries()) {
      owner[bucket] = vacancies[i] as number;
    }

    const next = this.placements.map((current, bucket): ShardPlacement => {
      const from = (current as { shard: number }).shard;
      const to = owner[bucket] as number;
      return from === to ? { kind: "settled", shard: to } : { kind: "migrating", from, to };
    });
    return new ShardPlan(shardCount, next);
  }

  /** Mark a migrating bucket as finished, owned by its destination. */
  settled(bucket: number): ShardPlan {
    const placement = this.placementAt(bucket);
    if (placement.kind === "settled") return this;
    const next = [...this.placements];
    next[bucket] = { kind: "settled", shard: placement.to };
    return new ShardPlan(this.shardCount, next);
  }

  /** Mark every migrating bucket settled. Only safe once their data has actually moved. */
  settledAll(): ShardPlan {
    if (this.isStable) return this;
    return new ShardPlan(
      this.shardCount,
      this.placements.map((p) => (p.kind === "settled" ? p : { kind: "settled", shard: p.to }))
    );
  }

  /** Every shard index the plan can route to — used to validate against a store's shards. */
  private assertValid(): void {
    for (const [bucket, placement] of this.placements.entries()) {
      const refs =
        placement.kind === "settled" ? [placement.shard] : [placement.from, placement.to];
      for (const shard of refs) {
        if (!Number.isInteger(shard) || shard < 0 || shard >= this.shardCount) {
          throw new Error(
            `ShardPlan bucket ${bucket} references shard ${shard}, outside 0..${this.shardCount - 1}`
          );
        }
      }
    }
  }
}
