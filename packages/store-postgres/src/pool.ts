import { Pool, type PoolConfig } from "pg";

// Accept a connection string or a full PoolConfig, or an already-built Pool to
// share one connection pool across the three stores.
export type PgConfig = string | PoolConfig | Pool;

export function toPool(config: PgConfig): { pool: Pool; owned: boolean } {
  if (config instanceof Pool) return { pool: config, owned: false };
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
