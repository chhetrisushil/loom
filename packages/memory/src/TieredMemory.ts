import type { MemoryDefinition } from "@loom/core";
import { MemoryRuntime } from "./MemoryRuntime";
import type { MemoryEntry, MemoryStore } from "./types";

// A decision sink shaped like ctx.decide (minus opts). When a flow passes ctx.decide
// to `recall`, the recalled set is recorded durably so replay serves the SAME data.
export type DecideFn = <T = unknown>(
  decisionId: string,
  decider: () => T | Promise<T>
) => Promise<T>;

export interface TierPolicy {
  /** Drop entries older than this (wall-clock TTL eviction). */
  ttlMs?: number;
  /** Hard cap — keep only the newest N (eviction). */
  maxEntries?: number;
  /**
   * Soft bound via summarization: when the tier exceeds this many entries, the
   * oldest are folded into a single summary entry (retains gist, not just the tail).
   * Prefer this over `maxEntries` for tiers where old context still matters.
   */
  summarizeAfter?: number;
}

/** Compress a set of entries into one summary entry's content. Injectable — swap in
 *  an LLM/reasoning summarizer; the default is deterministic and offline. */
export type Summarizer = (entries: MemoryEntry[]) => Promise<unknown> | unknown;

export interface TieredMemoryConfig {
  tiers: Record<string, TierPolicy>;
  store?: MemoryStore;
  summarizer?: Summarizer;
  now?: () => number;
}

export interface RecallRelevantOptions {
  /** Return at most N entries (best first). Defaults to the store's own default of 20. */
  limit?: number;
  /**
   * REQUIRED, unlike on {@link RecallOptions} — and that difference is the point.
   *
   * Recency recall re-reads a list the caller mostly controls; relevance recall ranks
   * over a corpus that grows (the `semantic`/`procedural` tiers never evict), so the set
   * it returns for the same question genuinely changes between the run and its replay.
   * Recorded through `decide` (P9), a replay is served the entries that ACTUALLY reached
   * the prompt. Requiring it here makes that a compile-time property rather than advice.
   *
   * If you truly want an unrecorded query — an ops lookup, a CLI, a test — call the
   * store's `search` directly. That bypass should be visible in the code.
   */
  decide: DecideFn;
  decisionKey?: string;
}

export interface RecallOptions {
  /** Return only the newest N entries. */
  limit?: number;
  /**
   * When set, the recalled set is recorded through it (P9), so replay/resume serves
   * the identical set even if the underlying store has since changed. Pass ctx.decide.
   */
  decide?: DecideFn;
  decisionKey?: string;
}

// The canonical tiers from the proposal. `working` is bounded by summarization (old
// scratch is folded, not dropped); `episodic` is hard-capped; `semantic`/`procedural`
// are durable (no eviction). Apps may define their own tier set instead.
export const DEFAULT_TIERS: Record<string, TierPolicy> = {
  working: { summarizeAfter: 20 },
  episodic: { maxEntries: 200 },
  semantic: {},
  procedural: {},
};

const defaultSummarizer: Summarizer = (entries) => ({
  summarized: entries.length,
  items: entries.map((e) => e.content),
});

/**
 * First-class tiered memory (Loom 2.0 M5) over the scoped {@link MemoryRuntime}: many
 * named tiers, each with its own eviction/summarization policy, plus promotion between
 * tiers. Crucially, `recall` can be *logged* through the decision seam so memory-driven
 * outcomes stay deterministic on replay — the fix that keeps non-deterministic recall
 * from breaking P2.
 */
export class TieredMemory {
  private readonly runtime: MemoryRuntime;
  private readonly tiers: Record<string, TierPolicy>;
  private readonly summarizer: Summarizer;
  private readonly now: () => number;

  constructor(config: TieredMemoryConfig) {
    this.runtime = new MemoryRuntime(config.store);
    this.tiers = config.tiers;
    this.summarizer = config.summarizer ?? defaultSummarizer;
    this.now = config.now ?? (() => Date.now());
    for (const [id, policy] of Object.entries(config.tiers)) {
      const def: MemoryDefinition = {
        _tag: "MemoryDefinition",
        id,
        name: id,
        ...(policy.ttlMs !== undefined && { ttlMs: policy.ttlMs }),
        ...(policy.maxEntries !== undefined && { maxEntries: policy.maxEntries }),
      };
      this.runtime.register(def);
    }
  }

  get tierNames(): string[] {
    return Object.keys(this.tiers);
  }

  private assertTier(tier: string): void {
    if (!(tier in this.tiers)) {
      throw new Error(`Unknown memory tier: "${tier}" (have: ${this.tierNames.join(", ")})`);
    }
  }

  async remember(
    tier: string,
    scope: string,
    entry: Omit<MemoryEntry, "timestamp"> & { timestamp?: number }
  ): Promise<void> {
    this.assertTier(tier);
    await this.runtime.append(tier, scope, { ...entry, timestamp: entry.timestamp ?? this.now() });
    // Keep summarizing tiers bounded automatically (summarization, not hard eviction).
    if (this.tiers[tier]?.summarizeAfter !== undefined) {
      await this.summarize(tier, scope);
    }
  }

  async recall(tier: string, scope: string, opts: RecallOptions = {}): Promise<MemoryEntry[]> {
    this.assertTier(tier);
    const read = async (): Promise<MemoryEntry[]> => {
      const entries = await this.runtime.read(tier, scope);
      return opts.limit !== undefined ? entries.slice(-opts.limit) : entries;
    };
    if (opts.decide !== undefined) {
      const key = opts.decisionKey ?? `recall:${tier}:${scope}`;
      return opts.decide(key, read);
    }
    return read();
  }

  /**
   * Recall by RELEVANCE to a question rather than by recency — the tier equivalent of
   * `MemoryStore.search`, and the only way to use a `semantic`/`procedural` tier without
   * loading it (neither evicts, so their "tail" means nothing).
   *
   * Always routed through `decide`, so what was retrieved is a recorded fact.
   */
  async recallRelevant(
    tier: string,
    scope: string,
    query: string,
    opts: RecallRelevantOptions
  ): Promise<MemoryEntry[]> {
    this.assertTier(tier);
    const key = opts.decisionKey ?? `recallRelevant:${tier}:${scope}:${query}`;
    return opts.decide(key, () =>
      this.runtime.search(tier, scope, query, {
        ...(opts.limit !== undefined && { limit: opts.limit }),
      })
    );
  }

  /** Copy (or move) entries matching `filter` from one tier to another. Returns the count. */
  async promote(
    from: string,
    to: string,
    scope: string,
    opts: { filter?: (e: MemoryEntry) => boolean; move?: boolean } = {}
  ): Promise<number> {
    this.assertTier(from);
    this.assertTier(to);
    const entries = await this.runtime.read(from, scope);
    const filter = opts.filter ?? (() => true);
    const promoted = entries.filter(filter);
    for (const e of promoted) await this.runtime.append(to, scope, e);
    if (opts.move === true && promoted.length > 0) {
      const kept = entries.filter((e) => !filter(e));
      await this.runtime.clear(from, scope);
      for (const e of kept) await this.runtime.append(from, scope, e);
    }
    return promoted.length;
  }

  /** Fold the oldest entries of a tier into one summary entry when it exceeds
   *  `summarizeAfter`. Returns true if it ran. */
  async summarize(tier: string, scope: string, opts: { keep?: number } = {}): Promise<boolean> {
    this.assertTier(tier);
    const threshold = this.tiers[tier]?.summarizeAfter;
    if (threshold === undefined) return false;
    const entries = await this.runtime.read(tier, scope);
    if (entries.length <= threshold) return false;
    const keep = opts.keep ?? Math.floor(threshold / 2);
    const cut = entries.length - keep;
    if (cut <= 0) return false;
    const old = entries.slice(0, cut);
    const rest = entries.slice(cut);
    const summary: MemoryEntry = {
      role: "summary",
      content: await this.summarizer(old),
      timestamp: old[old.length - 1]?.timestamp ?? this.now(),
    };
    await this.runtime.clear(tier, scope);
    await this.runtime.append(tier, scope, summary);
    for (const e of rest) await this.runtime.append(tier, scope, e);
    return true;
  }

  async clear(tier: string, scope: string): Promise<void> {
    this.assertTier(tier);
    await this.runtime.clear(tier, scope);
  }
}
