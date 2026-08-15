/**
 * A write lost the race for a `(executionId, sequence)` slot: something else already
 * occupies it. Every backend rejects this — SQLite and Postgres on their
 * `UNIQUE (execution_id, sequence)` constraint, the reference in-memory store on an
 * explicit check — and they normalize the failure to THIS type so a caller can tell a
 * sequence conflict from an ordinary write error without matching on driver text.
 *
 * The sibling of {@link StaleFenceError}, and the case fencing does not cover. Fencing
 * rejects a writer known to be superseded — it engages only once a token has been
 * acquired for the execution. Sequences are allocated per-process from folded state
 * (`ExecutionJournal` seeds from `vm.getState().sequence` and increments locally), so two
 * unfenced writers recovering the same execution allocate the SAME next sequence and
 * neither is a zombie. This is what stops the second one silently interleaving into the
 * log.
 */
export class DuplicateSequenceError extends Error {
  constructor(
    readonly executionId: string,
    readonly sequence: number,
    /** The driver error this was normalized from, when there was one. */
    readonly cause?: unknown
  ) {
    super(
      `duplicate sequence ${sequence} for execution "${executionId}": that slot is already occupied (another writer reached it first)`
    );
    this.name = "DuplicateSequenceError";
    Object.setPrototypeOf(this, DuplicateSequenceError.prototype);
  }
}
