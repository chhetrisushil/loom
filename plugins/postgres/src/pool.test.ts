import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { toPool } from "./pool";
import { postgresPool } from "./preset";

// No database needed: `new Pool(...)` is lazy, so these exercise the DISPATCH in
// `toPool` — which is where the dual-package hazard lives — without connecting.

/** A pool-shaped object from a notional second copy of `pg` (different constructor). */
function foreignPool(): object {
  return {
    connect: () => Promise.resolve({}),
    query: () => Promise.resolve({ rows: [] }),
    end: () => Promise.resolve(),
    options: { max: 12 },
  };
}

describe("toPool — dispatch", () => {
  it("borrows a Pool from THIS copy of pg rather than opening another", () => {
    const mine = new Pool({ connectionString: "postgres://u@localhost/db" });
    const { pool, owned } = toPool(mine);
    expect(pool).toBe(mine);
    expect(owned).toBe(false); // borrowed — the caller keeps the lifetime
  });

  it("builds and owns a pool from a connection string", () => {
    const { pool, owned } = toPool("postgres://u@localhost/db");
    expect(pool).toBeInstanceOf(Pool);
    expect(owned).toBe(true);
  });

  it("builds and owns a pool from a PoolConfig", () => {
    const { pool, owned } = toPool({ connectionString: "postgres://u@localhost/db", max: 3 });
    expect(pool).toBeInstanceOf(Pool);
    expect(owned).toBe(true);
  });

  it("REFUSES a pool from a different copy of pg, naming the cause", () => {
    // The regression this exists for: `instanceof` is constructor identity, so a consumer
    // wired by `link:` to a sibling checkout fails the check and used to fall through to
    // the PoolConfig branch — `new Pool(theirPoolObject)` — whose damage only appeared
    // later, inside pg's startup-packet serializer, as ERR_INVALID_ARG_TYPE.
    expect(() => toPool(foreignPool() as never)).toThrow(TypeError);
    expect(() => toPool(foreignPool() as never)).toThrow(/different copy of `pg`/);
    // The message has to carry the fix, or the error is only half the improvement.
    expect(() => toPool(foreignPool() as never)).toThrow(/postgresPool/);
  });

  it("does not mistake an ordinary PoolConfig for a foreign pool", () => {
    // The duck-type test must be specific enough that a legitimate config still works —
    // a config carrying unrelated function-valued fields is not a pool.
    const config = { connectionString: "postgres://u@localhost/db", log: () => {} };
    expect(() => toPool(config)).not.toThrow();
    expect(toPool(config).owned).toBe(true);
  });
});

describe("postgresPool", () => {
  it("is importable and returns a pool this package will accept", () => {
    // The whole point of exporting it: the returned pool must satisfy `toPool`'s
    // instanceof, which is what a consumer with its own `pg` cannot achieve alone.
    const pool = postgresPool({ connectionString: "postgres://u@localhost/db" });
    expect(pool).toBeInstanceOf(Pool);
    const { pool: same, owned } = toPool(pool);
    expect(same).toBe(pool);
    expect(owned).toBe(false);
  });
});
