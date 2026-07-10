import type { BranchRef, BranchRegistry, LineageRecord } from "./BranchRegistry";

export interface InMemoryBranchRegistryOptions {
  /** Injectable clock for createdAt/updatedAt (defaults to Date.now). */
  now?: () => number;
}

/**
 * Ephemeral, Map-based {@link BranchRegistry} — the browser-safe / test reference impl
 * alongside the Sqlite and Postgres ones. Pure JS, no native deps. Behaviour matches
 * the durable backends (verified by `runBranchRegistryConformance` in `@loom/testing`).
 */
export class InMemoryBranchRegistry implements BranchRegistry {
  private readonly refs = new Map<string, BranchRef>();
  private readonly lineage = new Map<string, LineageRecord>();
  private readonly now: () => number;

  constructor(options: InMemoryBranchRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async putRef(ref: BranchRef): Promise<void> {
    this.refs.set(ref.name, { ...ref });
  }

  async getRef(name: string): Promise<BranchRef | null> {
    const ref = this.refs.get(name);
    return ref !== undefined ? { ...ref } : null;
  }

  async listRefs(): Promise<BranchRef[]> {
    return [...this.refs.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async moveTip(name: string, tip: number): Promise<void> {
    const ref = this.refs.get(name);
    if (ref === undefined) return;
    ref.tip = tip;
    ref.updatedAt = this.now();
  }

  async promote(fromName: string, toName: string): Promise<void> {
    const from = this.refs.get(fromName);
    if (from === undefined) {
      throw new Error(`promote: branch "${fromName}" does not exist`);
    }
    const now = this.now();
    const to = this.refs.get(toName);
    if (to === undefined) {
      this.refs.set(toName, {
        name: toName,
        executionId: from.executionId,
        tip: from.tip,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      to.executionId = from.executionId;
      to.tip = from.tip;
      to.updatedAt = now;
    }
  }

  async deleteRef(name: string): Promise<void> {
    this.refs.delete(name);
  }

  async recordLineage(rec: Omit<LineageRecord, "createdAt">): Promise<void> {
    this.lineage.set(rec.executionId, { ...rec, createdAt: this.now() });
  }

  async getLineage(executionId: string): Promise<LineageRecord | null> {
    const rec = this.lineage.get(executionId);
    return rec !== undefined ? { ...rec } : null;
  }

  async children(executionId: string): Promise<LineageRecord[]> {
    return [...this.lineage.values()]
      .filter((l) => l.parentExecutionId === executionId)
      .map((l) => ({ ...l }));
  }

  async close(): Promise<void> {}
}
