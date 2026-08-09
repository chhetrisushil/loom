import { Pool, type PoolConfig } from "pg";

// Accept a connection string or a full PoolConfig, or an already-built Pool to
// share one connection pool across the three stores.
export type PgConfig = string | PoolConfig | Pool;

/**
 * A `Pool` from a DIFFERENT copy of `pg` than this package resolved.
 *
 * `instanceof` compares constructor identity, so it is false across two installs of the
 * same version — which is the normal state of affairs for a consumer wired by
 * `link:`/`file:` to a sibling checkout, since each side resolves `pg` from its own
 * `node_modules`. Without this check such a pool falls through to the `PoolConfig`
 * branch and is spread into `new Pool(…)`, producing a pool whose connection parameters
 * are objects. Nothing fails at the call: it surfaces later, and elsewhere, as
 * `ERR_INVALID_ARG_TYPE` from pg's startup-packet serializer — a genuinely hard trace to
 * walk back. Refusing here costs one duck-type test and turns that into a message that
 * names the cause.
 *
 * Deliberately structural, not a `Symbol.hasInstance` trick: the point is to recognise a
 * foreign pool well enough to REJECT it, never to use one. Sharing across copies cannot
 * be made to work — the two `pg` protocol implementations do not share internals.
 */
function looksLikeForeignPool(value: object): boolean {
  const v = value as { connect?: unknown; query?: unknown; end?: unknown };
  return (
    typeof v.connect === "function" && typeof v.query === "function" && typeof v.end === "function"
  );
}

export function toPool(config: PgConfig): { pool: Pool; owned: boolean } {
  if (config instanceof Pool) return { pool: config, owned: false };
  if (typeof config === "object" && config !== null && looksLikeForeignPool(config)) {
    throw new TypeError(
      "postgres: received a Pool from a different copy of `pg` than @loom/plugin-postgres resolved, " +
        "so it cannot be used (instanceof is constructor identity, and the two pg installs do not " +
        "share internals). This happens when the consumer is wired by `link:`/`file:` to a sibling " +
        "checkout and pg is not deduplicated into one store. Fix: build the pool with this package's " +
        "`postgresPool(config)` and pass that, or pass a connection string / PoolConfig and let each " +
        "store open its own."
    );
  }
  const poolConfig: PoolConfig = typeof config === "string" ? { connectionString: config } : config;
  return { pool: new Pool(poolConfig), owned: true };
}

// A process-unique id used to tag NOTIFY messages so a store ignores the events it
// published itself (it already delivered those to local subscribers synchronously).
// Avoids Math.random (a counter + pid is enough and keeps library code deterministic).
let counter = 0;
export function nextSenderId(): string {
  counter += 1;
  return `${process.pid}-${counter}`;
}
