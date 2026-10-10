import { type DecoratorPlan, installOptional } from "@loom/event-runtime";
import type { OptionalSnapshotStoreMethod, Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import type { ContentStore } from "./ContentStore";
import { type TouchErrorHook, touchAround } from "./touchAround";

export interface ContentTouchingSnapshotStoreOptions {
  /** See {@link TouchErrorHook}: the touch after a durable save, and a cited blob found missing. */
  onTouchError?: TouchErrorHook;
}

/**
 * ADR 0055 D6 amendment 2 — the SECOND citation path. `copyPrefix` copies only the post-gap events
 * of a compacted parent; the refs its truncated prefix cited live in the child's SEED SNAPSHOT
 * (the runtime's `fork` saves it), where an R5 media source or a claim-check envelope stays
 * verbatim and nothing `put`s it again. `ContentResolvingEventStore` cannot see it, so this
 * decorator touches the citations of every snapshot it SAVES, before and after, exactly as that
 * store does for events (same walker, same guarantee: D5's margin, see {@link touchAround}).
 *
 * Chosen over a hook in the runtime because the runtime holds no content store (and must not
 * depend on the content plugin), and over touching at fork start because a decorator also covers
 * compaction checkpoints and every other save with no extra seam. Cost: one iterative walk of the
 * saved state and a round trip only when it cites a blob; with a content store that has no `touch`
 * nothing at all.
 *
 * Wrap it OUTSIDE an `EncryptingSnapshotStore` (it must see the plaintext state, or refs under a
 * sensitive path are hidden from the walk), and pass the same content store the event log uses.
 * The seed is saved after the prefix copy, so a fork racing the DELETION of its own parent is
 * outside the guarantee (the fork's read of the parent fails then, too).
 */
export class ContentTouchingSnapshotStore implements SnapshotStore {
  readonly deleteExecution?: NonNullable<SnapshotStore["deleteExecution"]>;
  readonly loadLatestSealed?: NonNullable<SnapshotStore["loadLatestSealed"]>;
  private readonly onTouchError: TouchErrorHook | undefined;

  constructor(
    private readonly inner: SnapshotStore,
    private readonly content: Pick<ContentStore, "touch">,
    options: ContentTouchingSnapshotStoreOptions = {}
  ) {
    this.onTouchError = options.onTouchError;
    const plan = {
      deleteExecution: "forward",
      loadLatestSealed: "forward",
    } satisfies DecoratorPlan<SnapshotStore, OptionalSnapshotStoreMethod>;
    installOptional<SnapshotStore, OptionalSnapshotStoreMethod>(this, inner, plan);
  }

  save(snapshot: Snapshot): Promise<void> {
    return touchAround(
      this.content,
      [snapshot.state],
      { operation: "snapshotSave", executionId: snapshot.executionId },
      this.onTouchError,
      () => this.inner.save(snapshot)
    );
  }

  loadLatest(executionId: string): Promise<Snapshot | null> {
    return this.inner.loadLatest(executionId);
  }

  loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.inner.loadAt(executionId, sequence);
  }

  loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.inner.loadLatestBefore(executionId, sequence);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
