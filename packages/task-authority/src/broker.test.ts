import { describe, expect, it } from "vitest";
import { GrantBrokerError, InMemoryGrantLedger, type MintRequest } from "./broker";
import { TaskGrantShapeError } from "./errors";
import { taskGrantDigest, verifyTaskGrant } from "./grant";

const SECRET = "s3cret";
const NOW = 1_000_000;
const mk = (clock: { t: number } = { t: NOW }) =>
  new InMemoryGrantLedger({ secret: SECRET, now: () => clock.t });
const root = (over: Partial<MintRequest> = {}): MintRequest => ({
  taskId: "root",
  issuedTo: "agent",
  effects: ["db.read", "db.write"],
  leases: { w: { ceiling: 10, effects: ["db.write"] } },
  ttlMs: 1000,
  ...over,
});
const child = (
  taskId: string,
  ceiling: number,
  over: Partial<MintRequest> = {},
  parent = "root"
): MintRequest => ({
  taskId,
  issuedTo: "agent",
  effects: ["db.write"],
  leases: { w: { ceiling, effects: ["db.write"] } },
  ttlMs: 1000,
  parent: { taskId: parent },
  ...over,
});

describe("InMemoryGrantLedger mint", () => {
  it("mints a verifiable root", async () => {
    const g = await mk().mint(root());
    expect(g).toMatchObject({ taskId: "root", rootId: "root", epoch: 0, exp: NOW + 1000 });
    expect(g.parentId).toBeUndefined();
    expect(verifyTaskGrant(SECRET, g)).toBeDefined();
  });
  it("mints a child inheriting rootId and parentId", async () => {
    const b = mk();
    await b.mint(root());
    const c = await b.mint(child("c1", 4));
    expect(c).toMatchObject({ rootId: "root", parentId: "root" });
    expect(verifyTaskGrant(SECRET, c)).toBeDefined();
  });
  it("refuses child effects or lease names the parent lacks", async () => {
    const b = mk();
    await b.mint(root());
    await expect(b.mint(child("c1", 1, { effects: ["db.write", "net.out"] }))).rejects.toThrow(
      /effects/
    );
    await expect(
      b.mint(child("c2", 1, { leases: { x: { ceiling: 1, effects: ["db.write"] } } }))
    ).rejects.toThrow(/no lease x/);
  });
  it("refuses a missing or revoked parent", async () => {
    const b = mk();
    await expect(b.mint(child("c1", 1))).rejects.toThrow(/parent/);
    await b.mint(root());
    await b.revoke("root", "x");
    await expect(b.mint(child("c1", 1))).rejects.toThrow(/parent/);
  });
  it("refuses a ceiling over headroom, including two children together", async () => {
    const b = mk();
    await b.mint(root());
    await expect(b.mint(child("c0", 11))).rejects.toThrow(/headroom/);
    await b.mint(child("c1", 6));
    await expect(b.mint(child("c2", 5))).rejects.toThrow(/headroom/);
    await b.mint(child("c3", 4));
  });
  it("never releases a reservation: revoking c1 (10 of 10) does not free it", async () => {
    const b = mk();
    await b.mint(root());
    await b.mint(child("c1", 10));
    await b.revoke("c1", "x");
    await expect(b.mint(child("c2", 10))).rejects.toThrow(/headroom/);
  });
  it("accounts headroom per lease", async () => {
    const b = mk();
    const two = {
      leases: {
        w: { ceiling: 10, effects: ["db.write"] },
        r: { ceiling: 5, effects: ["db.read"] },
      },
    };
    await b.mint(root(two));
    const ask = (id: string, w: number, r: number) =>
      child(id, w, {
        effects: ["db.read", "db.write"],
        leases: {
          w: { ceiling: w, effects: ["db.write"] },
          r: { ceiling: r, effects: ["db.read"] },
        },
      });
    await b.mint(ask("c1", 10, 1));
    await expect(b.mint(ask("c2", 1, 1))).rejects.toThrow(/lease w/);
    await b.mint(
      child("c3", 1, { effects: ["db.read"], leases: { r: { ceiling: 4, effects: ["db.read"] } } })
    );
    await expect(
      b.mint(
        child("c4", 1, {
          effects: ["db.read"],
          leases: { r: { ceiling: 1, effects: ["db.read"] } },
        })
      )
    ).rejects.toThrow(/lease r/);
  });
  it("refuses a duplicate taskId", async () => {
    const b = mk();
    await b.mint(root());
    await expect(b.mint(root())).rejects.toThrow(/duplicate/);
  });
  it("refuses bad ttlMs values", async () => {
    const b = mk();
    for (const ttlMs of [
      -1,
      0,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      await expect(b.mint(root({ taskId: `r${ttlMs}`, ttlMs }))).rejects.toThrow(GrantBrokerError);
    await expect(b.mint(root({ taskId: "big", ttlMs: Number.MAX_SAFE_INTEGER }))).rejects.toThrow(
      GrantBrokerError
    );
  });
  it("clamps a child's exp to the parent's and refuses a mint under an expired parent", async () => {
    const clock = { t: NOW };
    const b = mk(clock);
    const p = await b.mint(root());
    clock.t = NOW + 500;
    const c = await b.mint(child("c1", 1, { ttlMs: 10_000 }));
    expect(c.exp).toBe(p.exp);
    const short = await b.mint(child("c2", 1, { ttlMs: 100 }));
    expect(short.exp).toBe(NOW + 600);
    clock.t = NOW + 1000;
    await expect(b.mint(child("c3", 1))).rejects.toThrow(/expired/);
  });
  it("copies the request and the returned grant", async () => {
    const b = mk();
    const req = root();
    await b.mint(req);
    req.effects.push("net.out");
    req.leases.w!.ceiling = 999;
    const g = await b.current("root");
    expect(g?.effects).toEqual(["db.read", "db.write"]);
    expect(g?.leases.w?.ceiling).toBe(10);
    (g as { effects: string[] }).effects.push("zzz");
    (g as unknown as { leases: { w: { ceiling: number } } }).leases.w.ceiling = 1;
    const again = await b.current("root");
    expect(again?.effects).toHaveLength(2);
    expect(again?.leases.w?.ceiling).toBe(10);
  });
  it("surfaces bad input as a typed error, never a TypeError", async () => {
    const b = mk();
    await b.mint(root());
    const bad = [
      root({ taskId: "a", leases: { w: null } as never }),
      root({ taskId: "b", effects: "db.read" as never }),
      child("c", 1, { leases: { w: null } as never }),
      child("d", 1, { effects: 5 as never }),
      null as never,
    ];
    for (const r of bad)
      await expect(b.mint(r)).rejects.toSatisfy(
        (e) => e instanceof TaskGrantShapeError || e instanceof GrantBrokerError
      );
    const cyc: Record<string, unknown> = { ...root({ taskId: "cy" }) };
    cyc.self = cyc;
    await expect(b.mint(cyc as never)).rejects.toThrow(GrantBrokerError);
    await expect(b.mint({ ...root({ taskId: "bi" }), x: 1n } as never)).rejects.toThrow(
      GrantBrokerError
    );
    await expect(
      b.mint({ ...root({ taskId: "hu" }), x: "y".repeat(70_000) } as never)
    ).rejects.toThrow(/too large/);
  });
});

describe("InMemoryGrantLedger revoke", () => {
  it("hides current, revokes the digest, cascades through three levels, is idempotent", async () => {
    const b = mk();
    const g = await b.mint(root());
    const c = await b.mint(child("c1", 6));
    const gc = await b.mint(child("g1", 3, {}, "c1"));
    await b.revoke("root", "bye");
    await b.revoke("root", "bye");
    for (const id of ["root", "c1", "g1"]) expect(await b.current(id)).toBeUndefined();
    for (const x of [g, c, gc]) expect(await b.revoked(taskGrantDigest(x))).toBe(true);
  });
  it("revoking a child leaves the parent live", async () => {
    const b = mk();
    await b.mint(root());
    const c = await b.mint(child("c1", 6));
    await b.revoke("c1", "x");
    expect(await b.current("root")).toBeDefined();
    expect(await b.revoked(taskGrantDigest(c))).toBe(true);
    await b.revoke("nope", "x");
  });
});
