// ── ProgressHub ───────────────────────────────────────────────────────────────
//
// A tiny in-process pub/sub keyed by executionId. Long-running step handlers
// narrate their work with progressHub.report(ctx.executionId, line); whoever
// started the execution (the A2A bus or the Orchestrator) subscribes with
// onReport(executionId, cb) to surface those lines in near-real-time.
//
// This is deliberately transport-agnostic and dependency-free so it can be
// imported by both the framework-facing handlers and the app-facing conductor
// without any import cycle.

type ReportCb = (line: string) => void;
type ProgressCb = (pct: number) => void;

class ProgressHub {
  private readonly subscribers = new Map<string, ReportCb>();
  private readonly progressSubs = new Map<string, ProgressCb>();

  onReport(executionId: string, cb: ReportCb): () => void {
    this.subscribers.set(executionId, cb);
    return () => this.subscribers.delete(executionId);
  }

  report(executionId: string, line: string): void {
    this.subscribers.get(executionId)?.(line);
  }

  // A separate numeric channel for long-running work that has genuine *progress*
  // (e.g. a migration backfilling rows). A branch's speculative simulation reports
  // its backfill percentage here; the BranchOrchestrator subscribes and streams it
  // onto the branch surface so the operator watches several branches advance at once.
  onProgress(executionId: string, cb: ProgressCb): () => void {
    this.progressSubs.set(executionId, cb);
    return () => this.progressSubs.delete(executionId);
  }

  reportProgress(executionId: string, pct: number): void {
    this.progressSubs.get(executionId)?.(pct);
  }
}

// App-wide singleton.
export const progressHub = new ProgressHub();
