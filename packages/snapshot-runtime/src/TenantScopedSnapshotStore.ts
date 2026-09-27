import { type DecoratorPlan, installOptional } from "@loom/event-runtime";
import type { OptionalSnapshotStoreMethod, Snapshot, SnapshotStore } from "./types";

const SEP = ":"; // ":" is not in the ULID alphabet — an unambiguous, collision-free tenant separator

/**
 * K12.5 — the snapshot half of tenant scoping (see `TenantScopedEventStore`).
 * Key-prefixes the executionId so a tenant-scoped store can only address its own
 * tenant's snapshots; the app sees its unprefixed ids.
 */
export class TenantScopedSnapshotStore implements SnapshotStore {
  readonly deleteExecution?: NonNullable<SnapshotStore["deleteExecution"]>;

  constructor(
    private readonly inner: SnapshotStore,
    private readonly tenant: string
  ) {
    if (tenant === "" || tenant.includes(SEP)) {
      // Prefix scoping is only isolation if no tenant's prefix is a prefix of another's:
      // tenant "a" scopes "b:x" to "a:b:x", which is tenant "a:b"'s "x".
      throw new TypeError(
        `TenantScopedSnapshotStore: tenant must be non-empty and must not contain the separator "${SEP}" (got ${JSON.stringify(tenant)})`
      );
    }
    const plan = {
      deleteExecution: (id) => inner.deleteExecution!(this.scope(id)),
    } satisfies DecoratorPlan<SnapshotStore, OptionalSnapshotStoreMethod>;
    installOptional<SnapshotStore, OptionalSnapshotStoreMethod>(this, inner, plan);
  }

  private scope(id: string): string {
    return `${this.tenant}${SEP}${id}`;
  }

  private unscope(s: Snapshot | null): Snapshot | null {
    if (s === null) return s;
    const prefix = `${this.tenant}${SEP}`;
    return s.executionId.startsWith(prefix)
      ? { ...s, executionId: s.executionId.slice(prefix.length) }
      : s;
  }

  async save(snapshot: Snapshot): Promise<void> {
    return this.inner.save({ ...snapshot, executionId: this.scope(snapshot.executionId) });
  }

  async loadLatest(executionId: string): Promise<Snapshot | null> {
    return this.unscope(await this.inner.loadLatest(this.scope(executionId)));
  }

  async loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.unscope(await this.inner.loadAt(this.scope(executionId), sequence));
  }

  async loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.unscope(await this.inner.loadLatestBefore(this.scope(executionId), sequence));
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
