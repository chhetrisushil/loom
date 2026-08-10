import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { toClientConfig, toPool } from "./pool";
import { postgresPool } from "./preset";

// No database needed: `new Pool(...)` is lazy, so these exercise the DISPATCH in
// `toPool` — which is where the dual-package hazard lives — without connecting.

/** A pool-shaped object from a notional second copy of `pg` (different constructor). */
function foreignPool(): object {
  return {
    connect: () => Promise.resolve({}),
    query: () => Promise.resolve({ rows: [] }),
    end: () => Promise.resolve(),
    options: { connectionString: "postgres://u@localhost/db", max: 12 },
  };
}

/** An API-compatible pool that is not `pg` at all — a serverless driver, a wrapper. */
function compatiblePool(): object {
  return {
    connect: () => Promise.resolve({}),
    query: () => Promise.resolve({ rows: [] }),
    end: () => Promise.resolve(),
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

  it("BORROWS a pool from a different copy of pg", () => {
    // The regression this exists for: `instanceof` is constructor identity, so a consumer
    // wired by `link:` to a sibling checkout fails that check. It used to fall through to
    // the PoolConfig branch — `new Pool(theirPoolObject)` — whose damage appeared only
    // later, inside pg's startup-packet serializer, as ERR_INVALID_ARG_TYPE. Detection was
    // the whole bug: the stores speak only the public protocol surface, so the pool itself
    // was always usable.
    const theirs = foreignPool();
    const { pool, owned } = toPool(theirs as never);
    expect(pool).toBe(theirs);
    expect(owned).toBe(false); // borrowed — never end() a pool we did not open
  });

  it("borrows an API-compatible pool that is not pg at all", () => {
    // Same discriminator, wider payoff: a serverless driver's drop-in Pool, an
    // instrumented or proxying wrapper, a test double.
    const theirs = compatiblePool();
    const { pool, owned } = toPool(theirs as never);
    expect(pool).toBe(theirs);
    expect(owned).toBe(false);
  });

  it("does not mistake an ordinary PoolConfig for a pool", () => {
    // The discriminator must be specific enough that a legitimate config still builds —
    // a config carrying unrelated function-valued fields is not a pool.
    const config = { connectionString: "postgres://u@localhost/db", log: () => {} };
    const { pool, owned } = toPool(config);
    expect(pool).toBeInstanceOf(Pool);
    expect(owned).toBe(true);
  });
});

describe("toClientConfig — the dedicated LISTEN session", () => {
  // A pooled client cannot hold LISTEN, so the event store opens its own Client. That
  // needs connection parameters, and a pool does not lend them out except via `options`.

  it("passes a connection string through", () => {
    expect(toClientConfig("postgres://u@localhost/db")).toBe("postgres://u@localhost/db");
  });

  it("passes a PoolConfig through", () => {
    const config = { connectionString: "postgres://u@localhost/db", max: 3 };
    expect(toClientConfig(config)).toBe(config);
  });

  it("reads `options` off a pool — including one from another copy of pg", () => {
    const mine = new Pool({ connectionString: "postgres://u@localhost/db" });
    expect(toClientConfig(mine)).toBe(mine.options);
    const theirs = foreignPool() as { options: unknown };
    expect(toClientConfig(theirs as never)).toBe(theirs.options);
  });

  it("returns undefined for a pool exposing no options, rather than the pool itself", () => {
    // The precise shape of the original bug: handing the pool object to `new Client(…)`
    // is what produced connection parameters that were objects. Undefined means the
    // caller degrades cross-node delivery; it never means "connect with this".
    expect(toClientConfig(compatiblePool() as never)).toBeUndefined();
  });
});

describe("postgresPool", () => {
  it("returns a real pg Pool, with the surface PoolLike omits", () => {
    // What it is still for: a caller that wants to size or instrument the pool it shares.
    const pool = postgresPool({ connectionString: "postgres://u@localhost/db" });
    expect(pool).toBeInstanceOf(Pool);
    expect(typeof pool.totalCount).toBe("number");
    const { pool: same, owned } = toPool(pool);
    expect(same).toBe(pool);
    expect(owned).toBe(false);
  });
});
