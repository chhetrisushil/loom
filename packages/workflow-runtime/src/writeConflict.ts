import { DuplicateEnvelopeIdError, DuplicateSequenceError } from "@loom/event-runtime";

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
