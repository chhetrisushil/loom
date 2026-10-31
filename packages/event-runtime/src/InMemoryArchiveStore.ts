import {
  type ArchiveSegment,
  type ArchiveSegmentHeader,
  type ArchiveStore,
  classifyAppend,
  headerOf,
} from "./archiveSpi";

/** In-memory {@link ArchiveStore}: for tests, the memory storage kind and in-memory event stores. */
export class InMemoryArchiveStore implements ArchiveStore {
  private readonly byExecution = new Map<string, ArchiveSegment[]>();

  async append(executionId: string, segment: ArchiveSegment): Promise<void> {
    const stored = this.byExecution.get(executionId) ?? [];
    if (classifyAppend(executionId, stored, segment) === "noop") return;
    // A copy through JSON, as a durable backend would hold it: the caller's objects never alias.
    const copy = JSON.parse(JSON.stringify(segment)) as ArchiveSegment;
    this.byExecution.set(executionId, [...stored, copy]);
  }

  async headers(executionId: string): Promise<ArchiveSegmentHeader[]> {
    return (this.byExecution.get(executionId) ?? []).map(headerOf);
  }

  async read(
    executionId: string,
    range: { readonly from?: number; readonly through?: number } = {}
  ): Promise<ArchiveSegment[]> {
    return (this.byExecution.get(executionId) ?? [])
      .filter(
        (s) =>
          (range.from === undefined || s.through >= range.from) &&
          (range.through === undefined || s.from <= range.through)
      )
      .map((s) => JSON.parse(JSON.stringify(s)) as ArchiveSegment);
  }

  async deleteExecution(executionId: string): Promise<void> {
    this.byExecution.delete(executionId);
  }

  async close(): Promise<void> {}
}
