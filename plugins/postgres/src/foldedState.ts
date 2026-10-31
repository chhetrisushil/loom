import type { PoolLike } from "./pool";

type Queryable = Pick<PoolLike, "query">;

// ADR 0132 D10 — caller-chosen placement for folded read-model state. The shared migrate()
// is untouched: these two tables are created lazily, under an advisory lock, only when a
// folded model is used (or by the app's own migration, via foldedStateDdl).

// 48 chars max (1 + up to 47) so the derived index names ("<table>_scope_idx") stay under
// Postgres's 63-byte identifier limit. ASCII only, so chars == bytes.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

export interface FoldedTableOptions {
  /**
   * Default: the pool's current schema (its search_path), like every other Loom store.
   * The schema must already exist: Loom never runs CREATE SCHEMA. Names are always quoted, hence
   * case-sensitive: an app's RLS policy or migration must quote mixed-case names too.
   */
  schema?: string;
  tables?: { state?: string; folds?: string };
}

/** Resolved, validated names. Computed once; everything downstream uses this, never the caller's options. */
export interface FoldedNames {
  state: string;
  folds: string;
  stateBare: string;
  keyIdx: string;
  scopeIdx: string;
}

// The shared Loom tables (schema.ts) — a folded table must never alias one of them.
const RESERVED = new Set([
  "events",
  "snapshots",
  "refs",
  "lineage",
  "fences",
  "timers",
  "leases",
  "durable_state",
  "read_model_rows",
  "read_model_watermarks",
  "memory_entries",
  "archive_segments",
]);

function ident(value: unknown, what: string): string {
  if (typeof value !== "string" || !IDENT.test(value)) {
    throw new TypeError(
      `PostgresReadModelStore: ${what} ${typeof value === "string" ? JSON.stringify(value) : `(${typeof value})`} is not a plain SQL identifier ([A-Za-z_][A-Za-z0-9_]{0,47})`
    );
  }
  return value;
}

export function foldedNames(o: FoldedTableOptions = {}): FoldedNames {
  const state = ident(o.tables?.state ?? "read_model_state", "state table");
  const folds = ident(o.tables?.folds ?? "read_model_folds", "folds table");
  const schema = o.schema === undefined ? undefined : ident(o.schema, "schema");
  if (state === folds) {
    throw new TypeError("PostgresReadModelStore: state and folds tables must differ");
  }
  for (const t of [state, folds]) {
    if (RESERVED.has(t)) {
      throw new TypeError(`PostgresReadModelStore: "${t}" is a shared Loom table name`);
    }
  }
  const q = (t: string): string => (schema === undefined ? `"${t}"` : `"${schema}"."${t}"`);
  return {
    state: q(state),
    folds: q(folds),
    stateBare: state,
    keyIdx: `${state}_key_idx`,
    scopeIdx: `${state}_scope_idx`,
  };
}

function ddlFor(n: FoldedNames): string {
  return `
    CREATE TABLE IF NOT EXISTS ${n.folds} (
      model_id TEXT PRIMARY KEY,
      version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${n.state} (
      model_id TEXT NOT NULL,
      execution_id TEXT COLLATE "C" NOT NULL,
      app_key TEXT,
      scope TEXT,
      sequence BIGINT NOT NULL,
      state JSONB,
      erased BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (model_id, execution_id)
    );
    CREATE INDEX IF NOT EXISTS "${n.keyIdx}" ON ${n.state} (model_id, app_key) WHERE app_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS "${n.scopeIdx}" ON ${n.state} (model_id, scope) WHERE scope IS NOT NULL;
  `;
}

/** Pure DDL — drop it into the app's own migration, then add RLS policies on `scope`. */
export function foldedStateDdl(o: FoldedTableOptions = {}): string {
  return ddlFor(foldedNames(o));
}

// Lock-free catalog probe (same pattern as schema.ts): CREATE ... IF NOT EXISTS on an existing
// object still takes a lock (and needs ownership), so an existing install must issue no DDL.
async function complete(pool: Queryable, n: FoldedNames): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AND
       (SELECT count(*) FROM pg_class c
         WHERE c.relname = ANY($3::text[])
           AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = to_regclass($1))) = 2 AS ok`,
    [n.state, n.folds, [n.keyIdx, n.scopeIdx]]
  );
  return rows[0]?.ok === true;
}

/** Create the tables once per process, serialized across nodes by a transaction-scoped advisory lock. */
export async function ensureFoldedTables(pool: PoolLike, n: FoldedNames): Promise<void> {
  if (await complete(pool, n)) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`loom:folded:${n.state}`]);
    if (!(await complete(client, n))) await client.query(ddlFor(n));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
