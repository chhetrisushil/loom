import type { PoolLike } from "./pool";

// ADR 0132 D10 — caller-chosen placement for folded read-model state. The shared migrate()
// is untouched: these two tables are created lazily, under an advisory lock, only when a
// folded model is used (or by the app's own migration, via foldedStateDdl).

// 48 chars max (1 + up to 47) so the derived index names ("<table>_scope_idx") stay under
// Postgres's 63-byte identifier limit. ASCII only, so chars == bytes.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

export interface FoldedTableOptions {
  /** Default: the pool's current schema (its search_path), like every other Loom store. */
  schema?: string;
  tables?: { state?: string; folds?: string };
}

export interface FoldedNames {
  state: string;
  folds: string;
  stateBare: string;
}

function ident(value: string, what: string): string {
  if (!IDENT.test(value)) {
    throw new TypeError(
      `PostgresReadModelStore: ${what} ${JSON.stringify(value)} is not a plain SQL identifier ([A-Za-z_][A-Za-z0-9_]{0,47})`
    );
  }
  return `"${value}"`;
}

export function foldedNames(o: FoldedTableOptions = {}): FoldedNames {
  const state = o.tables?.state ?? "read_model_state";
  const folds = o.tables?.folds ?? "read_model_folds";
  const qualify = (t: string, what: string): string =>
    o.schema === undefined ? ident(t, what) : `${ident(o.schema, "schema")}.${ident(t, what)}`;
  return {
    state: qualify(state, "state table"),
    folds: qualify(folds, "folds table"),
    stateBare: state,
  };
}

/** Pure DDL — drop it into the app's own migration, then add RLS policies on `scope`. */
export function foldedStateDdl(o: FoldedTableOptions = {}): string {
  const n = foldedNames(o);
  return `
    CREATE TABLE IF NOT EXISTS ${n.folds} (
      model_id TEXT PRIMARY KEY,
      version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${n.state} (
      model_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      app_key TEXT,
      scope TEXT,
      sequence BIGINT NOT NULL,
      state JSONB,
      erased BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (model_id, execution_id)
    );
    CREATE INDEX IF NOT EXISTS "${n.stateBare}_key_idx" ON ${n.state} (model_id, app_key) WHERE app_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS "${n.stateBare}_scope_idx" ON ${n.state} (model_id, scope) WHERE scope IS NOT NULL;
  `;
}

/** Create the tables once per process, serialized across nodes by a transaction-scoped advisory lock. */
export async function ensureFoldedTables(
  pool: PoolLike,
  o: FoldedTableOptions = {}
): Promise<void> {
  const n = foldedNames(o);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`loom:folded:${n.state}`]);
    await client.query(foldedStateDdl(o));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
