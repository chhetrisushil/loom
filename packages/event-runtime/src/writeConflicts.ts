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

/**
 * An envelope re-used an `id` that is already in the log. Ids are unique **across the
 * whole store**, not per execution — both SQL backends key `id` as the events table's
 * PRIMARY KEY — and every backend rejects a collision rather than storing the second
 * envelope or silently treating it as a re-delivery of the first.
 *
 * The other of the events table's two keys, and a genuinely different failure from
 * {@link DuplicateSequenceError}: a taken SEQUENCE means another writer reached that slot
 * in this execution's log (a lost race), while a taken ID means the same envelope identity
 * was minted twice (a bug in whatever produced it). Reporting either as the other sends
 * the reader hunting the wrong problem, which is why they are separate types.
 */
export class DuplicateEnvelopeIdError extends Error {
  constructor(
    readonly envelopeId: string,
    readonly executionId: string,
    /** The driver error this was normalized from, when there was one. */
    readonly cause?: unknown
  ) {
    super(
      `duplicate envelope id "${envelopeId}" (execution "${executionId}"): event ids are unique across the store, and that one is already taken`
    );
    this.name = "DuplicateEnvelopeIdError";
    Object.setPrototypeOf(this, DuplicateEnvelopeIdError.prototype);
  }
}
