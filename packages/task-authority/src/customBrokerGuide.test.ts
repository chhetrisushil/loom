import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConformanceReport, checkTaskAuthorityConformance } from "./conformance";
import { type GrantBroker, InMemoryGrantBroker } from "./index";

// The code of docs/custom-grant-broker.md: the doc mirrors these regions byte for byte (last test).

type Options = ConstructorParameters<typeof InMemoryGrantBroker>[0];
const secret = "guide-secret";

// #region policy
const broker = new InMemoryGrantBroker({
  secret,
  policy: (request, { renewals }) =>
    renewals < 3 && (request.spent.email ?? 0) <= 20 ? { leases: { email: 20 } } : false,
  approveCrossLineage: (request) => request.lineages?.length === 1,
});
// #endregion policy

// #region broker
/** Where the broker's state lives. `update` must be exclusive across every process. */
interface GrantState {
  read(): Promise<string>;
  update<T>(change: (text: string) => Promise<{ text: string; result: T }>): Promise<T>;
}

/** The reference broker, with its state loaded from and dumped to one JSON text. */
class LoadedBroker extends InMemoryGrantBroker {
  load(text: string): this {
    if (text === "") return this; // the migration's empty row: a new broker
    const s = JSON.parse(text);
    for (const [id, r] of s.tasks) this.tasks.set(id, { ...r, children: new Set(r.children) });
    for (const digest of s.revokedDigests) this.revokedDigests.add(digest);
    for (const [id, v] of s.claims) this.claims.set(id, v);
    for (const [id, v] of s.reservations) this.reservations.set(id, v);
    for (const [id, v] of s.carved) this.carved.set(id, v);
    return this;
  }
  dump(): string {
    return JSON.stringify({
      tasks: [...this.tasks].map(([id, r]) => [id, { ...r, children: [...r.children] }]),
      revokedDigests: [...this.revokedDigests],
      claims: [...this.claims],
      reservations: [...this.reservations],
      carved: [...this.carved],
    });
  }
}

class DurableGrantBroker implements GrantBroker {
  constructor(
    private readonly state: GrantState,
    private readonly options: ConstructorParameters<typeof InMemoryGrantBroker>[0]
  ) {}
  private async read<T>(get: (b: LoadedBroker) => Promise<T>): Promise<T> {
    return get(new LoadedBroker(this.options).load(await this.state.read()));
  }
  private write<T>(change: (b: LoadedBroker) => Promise<T>): Promise<T> {
    return this.state.update(async (text) => {
      const b = new LoadedBroker(this.options).load(text);
      const result = await change(b); // a throw rolls back: nothing is stored
      return { text: b.dump(), result };
    });
  }
  current = (taskId: string) => this.read((b) => b.current(taskId));
  revoked = (digest: string) => this.read((b) => b.revoked(digest));
  holder = (taskId: string) => this.read((b) => b.holder(taskId));
  claim = (taskId: string, executionId: string) => this.write((b) => b.claim(taskId, executionId));
  mint = (...a: Parameters<GrantBroker["mint"]>) => this.write((b) => b.mint(...a));
  renew = (...a: Parameters<GrantBroker["renew"]>) => this.write((b) => b.renew(...a));
  revoke = (...a: Parameters<GrantBroker["revoke"]>) => this.write((b) => b.revoke(...a));
  reserve = (...a: Parameters<GrantBroker["reserve"]>) => this.write((b) => b.reserve(...a));
  settleChild = (...a: Parameters<GrantBroker["settleChild"]>) =>
    this.write((b) => b.settleChild(...a));
  settleUnstarted = (...a: Parameters<GrantBroker["settleUnstarted"]>) =>
    this.write((b) => b.settleUnstarted(...a));
  takeReturn = (...a: Parameters<GrantBroker["takeReturn"]>) =>
    this.write((b) => b.takeReturn(...a));
}
// #endregion broker

// #region postgres
const MIGRATION = `
  CREATE TABLE IF NOT EXISTS grant_broker (id TEXT PRIMARY KEY, state TEXT NOT NULL);
  INSERT INTO grant_broker VALUES ('default', '') ON CONFLICT DO NOTHING;
`;

class PostgresGrantState implements GrantState {
  constructor(
    private readonly pool: Pool,
    private readonly id = "default"
  ) {}
  async read(): Promise<string> {
    const { rows } = await this.pool.query("SELECT state FROM grant_broker WHERE id = $1", [
      this.id,
    ]);
    return this.only(rows);
  }
  async update<T>(change: (text: string) => Promise<{ text: string; result: T }>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT state FROM grant_broker WHERE id = $1 FOR UPDATE", // the cross-process lock
        [this.id]
      );
      const { text, result } = await change(this.only(rows));
      await client.query("UPDATE grant_broker SET state = $2 WHERE id = $1", [this.id, text]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch((e: Error) => {
        broken = e;
      });
      throw error;
    } finally {
      client.release(broken); // a connection that could not roll back is destroyed
    }
  }
  /** A lost row is an error, never an empty broker: an empty one would forget every claim and revocation. */
  private only(rows: { state: string }[]): string {
    if (rows[0] === undefined) throw new Error(`grant_broker row "${this.id}" is missing`);
    return rows[0].state;
  }
}
// #endregion postgres

/** An in-process state with real interleaving points, serialized by a queue. */
class QueuedState implements GrantState {
  text = "";
  private tail: Promise<unknown> = Promise.resolve();
  read = async () => this.text;
  update<T>(change: (text: string) => Promise<{ text: string; result: T }>): Promise<T> {
    const run = this.tail.then(async () => {
      const next = await change(this.text);
      this.text = next.text;
      return next.result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
const kit = (state: () => GrantState, B: typeof DurableGrantBroker = DurableGrantBroker) =>
  checkTaskAuthorityConformance({ makeBroker: (o) => new B(state(), o) });
const notPassed = (r: ConformanceReport) =>
  r.results.filter((x) => x.status !== "passed").map((x) => `${x.status} ${x.id}`);
const request = (taskId: string) => ({
  taskId,
  issuedTo: "agent-a",
  effects: ["email.send"],
  leases: { email: { ceiling: 2, effects: ["email.send"] } },
  ttlMs: 60_000,
});

describe("docs/custom-grant-broker.md", () => {
  it("the custom policy renews to the new total and stops after three", async () => {
    await broker.mint(request("t"));
    for (const epoch of [0, 1, 2])
      expect(
        await broker.renew({ taskId: "t", epoch, spent: { email: 2 }, renewals: epoch })
      ).toMatchObject({ granted: true });
    expect((await broker.current("t"))?.leases.email?.ceiling).toBe(20);
    expect(
      await broker.renew({ taskId: "t", epoch: 3, spent: { email: 2 }, renewals: 3 })
    ).toMatchObject({ granted: false });
  });

  it("the durable broker passes the kit (only the A2A check is skipped)", async () => {
    expect(notPassed(await kit(() => new QueuedState()))).toEqual([
      "skipped laundering.uncovered.a2a",
    ]);
  });

  it("the kit fails a state that is not exclusive", async () => {
    class Racy extends QueuedState {
      override async update<T>(change: (text: string) => Promise<{ text: string; result: T }>) {
        const next = await change(this.text); // read, yield, write: no lock
        this.text = next.text;
        return next.result;
      }
    }
    expect(notPassed(await kit(() => new Racy()))).toContain("failed broker.claim-atomic");
  });

  it("dumps every collection the reference broker holds, and survives a reload", async () => {
    const held = Object.entries(new InMemoryGrantBroker({ secret }))
      .filter(([, v]) => v instanceof Map || v instanceof Set)
      .map(([k]) => k);
    const state = new QueuedState();
    const first = new DurableGrantBroker(state, { secret });
    const grant = await first.mint(request("t"));
    await first.claim("t", "e1");
    expect(Object.keys(JSON.parse(state.text)).sort()).toEqual(held.sort());
    const second = new DurableGrantBroker(state, { secret });
    expect(await second.current("t")).toEqual(grant);
    expect([await second.holder("t"), await second.claim("t", "e2")]).toEqual(["e1", false]);
  });

  it("every ts block mirrors a region of this file", () => {
    const here = readFileSync(join(__dirname, "customBrokerGuide.test.ts"), "utf8");
    const doc = readFileSync(join(__dirname, "../../../docs/custom-grant-broker.md"), "utf8");
    const blocks = [
      ...doc.matchAll(/(?:<!-- (snippet|illustrative): (.+?) -->\n)?```ts\n([\s\S]*?)```/g),
    ];
    expect(blocks.filter((b) => b[1] === "snippet").length).toBe(3);
    for (const [, kind, name, code] of blocks) {
      expect(kind, `unmarked block:\n${code}`).toBeDefined();
      if (kind === "snippet")
        expect(code).toBe(here.split(`// #region ${name}\n`)[1]?.split(`// #endregion ${name}`)[0]);
    }
  });
});

const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
describe.skipIf(PG_URL === undefined)("docs/custom-grant-broker.md on Postgres", () => {
  const pools = [
    new Pool({ connectionString: PG_URL }),
    new Pool({ connectionString: PG_URL }),
  ] as const;
  const opts: Options = { secret };
  beforeAll(async () => {
    await pools[0].query("DROP TABLE IF EXISTS grant_broker");
    await pools[0].query(MIGRATION);
    await pools[0].query(
      "INSERT INTO grant_broker SELECT 'kit' || n, '' FROM generate_series(1, 200) n"
    );
  });
  afterAll(async () => {
    await pools[0].query("DROP TABLE IF EXISTS grant_broker");
    await Promise.all(pools.map((p) => p.end()));
  });

  it("passes the kit", { timeout: 60_000 }, async () => {
    let n = 0;
    const report = await kit(() => new PostgresGrantState(pools[0], `kit${++n}`));
    expect(notPassed(report)).toEqual(["skipped laundering.uncovered.a2a"]);
  });

  it("two pools racing one claim: one wins, and both see it", { timeout: 60_000 }, async () => {
    const on = (p: Pool): GrantBroker => new DurableGrantBroker(new PostgresGrantState(p), opts);
    const a = on(pools[0]);
    const b = on(pools[1]);
    await a.mint(request("t"));
    const won = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).claim("t", `e${i}`))
    );
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(await a.holder("t")).toBe(await b.holder("t"));
    await expect(b.mint(request("t"))).rejects.toThrow("duplicate taskId");
  });

  it("a missing row is an error, not an empty broker", async () => {
    const lost = new DurableGrantBroker(new PostgresGrantState(pools[0], "nope"), opts);
    await expect(lost.current("t")).rejects.toThrow("is missing");
    await expect(lost.mint(request("t"))).rejects.toThrow("is missing");
  });
});
