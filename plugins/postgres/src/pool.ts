import { Pool, type PoolConfig } from "pg";

/**
 * The entire `Pool` surface this package uses.
 *
 * Declared structurally, and deliberately narrow — every store field and every helper is
 * typed against THIS, not `pg`'s `Pool`. That makes "we never reach into pg's internals"
 * a compile-time property rather than a claim: adding a call outside this surface stops
 * building, and the widening below stops being safe the moment it stops being true.
 *
 * `options` is optional because only a real `pg` pool is guaranteed to carry it; it is
 * read on exactly one path (the dedicated LISTEN connection, which needs connection
 * parameters a pool cannot lend out) and its absence degrades that path rather than
 * breaking construction.
 */
export interface PoolLike {
  query: Pool["query"];
  connect: Pool["connect"];
  end: Pool["end"];
  options?: PoolConfig;
}

// Accept a connection string or a full PoolConfig, or an already-built pool to share one
// connection pool across the stores.
export type PgConfig = string | PoolConfig | Pool | PoolLike;

/**
 * Recognise an already-built pool structurally, because `instanceof Pool` cannot.
 *
 * `instanceof` compares constructor identity, so it is false across two installs of the
 * same version — the normal state for a consumer wired by `link:`/`file:` to a sibling
 * checkout, where each side resolves `pg` from its own `node_modules`. Such a pool used to
 * fall through to the `PoolConfig` branch and get spread into `new Pool(…)`, producing a
 * pool whose connection parameters are objects. Nothing failed at the call; it surfaced
 * later and elsewhere as `ERR_INVALID_ARG_TYPE` from pg's startup-packet serializer.
 *
 * This is a safe discriminator rather than a heuristic: `PoolConfig` declares no
 * `connect`/`query`/`end`, so a legitimate config cannot satisfy it (asserted by a test
 * that passes a config carrying unrelated function-valued fields).
 */
function looksLikePool(value: object): value is PoolLike {
  const v = value as { connect?: unknown; query?: unknown; end?: unknown };
  return (
    typeof v.connect === "function" && typeof v.query === "function" && typeof v.end === "function"
  );
}

/**
 * Resolve a {@link PgConfig} to the pool the stores will use, and say whether we own it.
 *
 * A pool arriving from a different copy of `pg` is BORROWED, not refused. The stores only
 * ever call `query`, `connect`/`release` and `end` — the public protocol surface, which is
 * what {@link PoolLike} pins — so the two installs never need to share internals, and the
 * cross-copy failure was only ever the misdetection above. Refusing it also turned away
 * every other API-compatible pool: a serverless driver, an instrumented or proxying
 * wrapper, a test double.
 *
 * Ownership follows construction, unchanged: a pool we were handed is never `end()`ed by
 * a store's `close()`, whichever copy of pg built it.
 */
export function toPool(config: PgConfig): { pool: PoolLike; owned: boolean } {
  if (config instanceof Pool) return { pool: config, owned: false };
  if (typeof config === "object" && config !== null && looksLikePool(config)) {
    return { pool: config, owned: false };
  }
  const poolConfig: PoolConfig =
    typeof config === "string" ? { connectionString: config } : (config as PoolConfig);
  return { pool: new Pool(poolConfig), owned: true };
}

/**
 * Derive connection parameters for a dedicated `Client` from whatever the store was
 * configured with. Used only for the LISTEN session, which cannot borrow a pooled client.
 *
 * Returns `undefined` when a pool was supplied that does not expose `options` — a
 * non-`pg` pool-like. There is nothing to fall back to there: passing the pool object
 * itself to `new Client(…)` is precisely the bug that started all of this.
 */
export function toClientConfig(config: PgConfig): string | PoolConfig | undefined {
  if (typeof config === "string") return config;
  if (typeof config === "object" && config !== null && looksLikePool(config)) {
    return config.options;
  }
  return config as PoolConfig;
}

// A process-unique id used to tag NOTIFY messages so a store ignores the events it
// published itself (it already delivered those to local subscribers synchronously).
// Avoids Math.random (a counter + pid is enough and keeps library code deterministic).
let counter = 0;
export function nextSenderId(): string {
  counter += 1;
  return `${process.pid}-${counter}`;
}
