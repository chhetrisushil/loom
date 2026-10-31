import type {
  ArchiveExecutionPage,
  ArchiveSegment,
  ArchiveSegmentHeader,
  ArchiveStore,
} from "./archiveSpi";
import { compareExecutionIds } from "./executionIdOrder";

const SEP = ":"; // the same tenant separator as TenantScopedEventStore / TenantScopedSnapshotStore

/**
 * ADR 0138 H3 - the archive half of tenant scoping (see `TenantScopedEventStore`). Key-prefixes the
 * executionId so a `LogLifecycle` over a tenant-scoped event store, given a shared archive, can only
 * address its own tenant's segments: another tenant's history cannot be read, extended, or (on the
 * plain-delete retention path) deleted, by construction. `LogLifecycle.compact` REFUSES a tenant-scoped
 * event store paired with an archive that is not scoped to the SAME tenant (`tenantScope` is the marker).
 *
 * The sealing markers of a wrapped `EncryptingArchiveStore` (`keys`, `sealsSegments`, `subjectOf`)
 * are forwarded, so the erasure-boundary guard sees through this decorator.
 */
export class TenantScopedArchiveStore implements ArchiveStore {
  readonly deleteExecution?: NonNullable<ArchiveStore["deleteExecution"]>;

  constructor(
    private readonly inner: ArchiveStore,
    private readonly tenant: string
  ) {
    if (tenant === "" || tenant.includes(SEP)) {
      throw new TypeError(
        `TenantScopedArchiveStore: tenant must be non-empty and must not contain the separator "${SEP}" (got ${JSON.stringify(tenant)})`
      );
    }
    const innerDelete = inner.deleteExecution;
    if (innerDelete !== undefined) {
      this.deleteExecution = (id) => innerDelete.call(inner, this.scope(id));
    }
  }

  /** Structural marker: the tenant this archive is scoped to (read by `LogLifecycle.compact`). */
  get tenantScope(): string {
    return this.tenant;
  }
  get keys(): unknown {
    return (this.inner as { keys?: unknown }).keys;
  }
  get sealsSegments(): unknown {
    return (this.inner as { sealsSegments?: unknown }).sealsSegments;
  }
  get subjectOf(): unknown {
    return (this.inner as { subjectOf?: unknown }).subjectOf;
  }

  private scope(id: string): string {
    return `${this.tenant}${SEP}${id}`;
  }

  append(executionId: string, segment: ArchiveSegment): Promise<void> {
    return this.inner.append(this.scope(executionId), segment);
  }

  headers(executionId: string): Promise<ArchiveSegmentHeader[]> {
    return this.inner.headers(this.scope(executionId));
  }

  read(
    executionId: string,
    range?: { readonly from?: number; readonly through?: number }
  ): Promise<ArchiveSegment[]> {
    return this.inner.read(this.scope(executionId), range);
  }

  async listExecutions(
    opts: { cursor?: string; limit?: number } = {}
  ): Promise<ArchiveExecutionPage> {
    const prefix = `${this.tenant}${SEP}`;
    // Seek to the tenant's contiguous id range, and stop at the first id past it.
    let cursor =
      opts.cursor === undefined ? `${this.tenant}9\u{10FFFF}` : `${prefix}${opts.cursor}`;
    for (;;) {
      const page = await this.inner.listExecutions({
        cursor,
        ...(opts.limit !== undefined && { limit: opts.limit }),
      });
      const executionIds: string[] = [];
      let past = false;
      for (const id of page.executionIds) {
        if (id.startsWith(prefix)) executionIds.push(id.slice(prefix.length));
        else if (compareExecutionIds(id, prefix) > 0) {
          past = true;
          break;
        }
      }
      if (past || page.nextCursor === undefined) return { executionIds };
      const last = executionIds[executionIds.length - 1];
      if (last !== undefined) return { executionIds, nextCursor: last };
      if (page.nextCursor === cursor) {
        throw new TypeError(
          "TenantScopedArchiveStore: listExecutions returned a non-advancing cursor"
        );
      }
      cursor = page.nextCursor;
    }
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
