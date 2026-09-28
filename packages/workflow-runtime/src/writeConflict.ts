import {
  DuplicateEnvelopeIdError,
  DuplicateSequenceError,
  StaleFenceError,
} from "@loom/event-runtime";

/**
 * ADR 0103 — did the store refuse a write because A slot or id is already taken? Both
 * conflicts are normalized by every backend (see `EventStore.append`). This says nothing about
 * WHOSE write conflicted — a coalesced batch hands every caller the same error — so
 * `writeBootstrap` confirms by reading sequence 0 back. Matched by `name` as well as class so a
 * second copy of `@loom/event-runtime` in a bundle cannot hide a conflict.
 */
export function isWriteConflict(err: unknown): boolean {
  if (err instanceof DuplicateSequenceError || err instanceof DuplicateEnvelopeIdError) {
    return true;
  }
  const name = (err as { name?: unknown } | null)?.name;
  return name === "DuplicateSequenceError" || name === "DuplicateEnvelopeIdError";
}

/**
 * ADR 0103 (L12) — did a fencing store refuse a write because the execution holds a newer
 * token? At a bootstrap this is the other way a duplicate start is refused: the existing
 * execution has been fenced (by a recovery pass, a fenced wake, or a start that fenced itself),
 * so an unfenced or older-token sequence 0 loses on the fence before it can conflict on the
 * slot. Like a conflict it says nothing about WHOSE write it was (a coalesced batch rejects
 * every caller with a zombie's error), so `writeBootstrap` confirms it the same way. Matched by
 * `name` as well as class, for the same reason as {@link isWriteConflict}.
 */
export function isStaleFence(err: unknown): boolean {
  if (err instanceof StaleFenceError) return true;
  return (err as { name?: unknown } | null)?.name === "StaleFenceError";
}
