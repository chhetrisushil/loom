import { CliError } from "./args";
import { makeRedactor } from "./core";
import { type StoreFlags, resolveStores } from "./stores";

/**
 * `loom snapshot show <executionId> [--at SEQ] [--redact a,b]` - print one stored snapshot, DECODED.
 *
 * ADR 0141: a snapshot may be stored as a zstd frame (a BYTEA/BLOB), which `SELECT state->…` cannot
 * traverse and `psql` prints as hex. This reads it through the same `SnapshotStore` the runtime resumes
 * from (so an encrypting store opens it, and either storage format decodes), and prints the snapshot as
 * indented JSON: `{ id, executionId, workflowId, sequence, createdAt, state }`. Read-only.
 *
 * Without `--at` it is the latest snapshot; with `--at SEQ`, the one stored at exactly SEQ (it does not
 * pick a neighbour: a snapshot at another sequence is a different state, and saying so beats a quiet
 * substitution).
 */
export async function cmdSnapshotShow(
  flags: StoreFlags,
  executionId: string,
  at?: number,
  redact: readonly string[] = []
): Promise<string> {
  const resolved = await resolveStores(flags);
  try {
    const store = resolved.snapshotStore;
    if (store === undefined) {
      throw new CliError(
        resolved.origin === "db"
          ? "no snapshot store: with --db, also pass --snap <snapshots.db>"
          : "this config has no snapshot store to read",
        2
      );
    }
    const snapshot =
      at === undefined ? await store.loadLatest(executionId) : await store.loadAt(executionId, at);
    if (snapshot === null) {
      throw new CliError(
        at === undefined
          ? `no snapshot for execution ${executionId}`
          : `no snapshot for execution ${executionId} at sequence ${at} (omit --at for the latest)`,
        1
      );
    }
    const r = makeRedactor(redact);
    const state = r.scrub(r.mask(snapshot.state));
    return JSON.stringify(
      {
        id: snapshot.id,
        executionId: snapshot.executionId,
        workflowId: snapshot.workflowId,
        sequence: snapshot.sequence,
        createdAt: snapshot.createdAt,
        state,
      },
      null,
      2
    );
  } finally {
    await resolved.close();
  }
}
