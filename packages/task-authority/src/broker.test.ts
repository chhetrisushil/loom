import { isTainted, taintOf, tainted } from "@loomwork/classify";
import { describe, expect, it } from "vitest";
import { InMemoryGrantBroker, type MintRequest, type RenewalRequest } from "./broker";
import { taskGrantDigest, verifyTaskGrant } from "./grant";

const SECRET = "s3cret";
const NOW = 1_000_000;
const mk = (policy?: ConstructorParameters<typeof InMemoryGrantBroker>[0]["policy"]) =>
  new InMemoryGrantBroker({ secret: SECRET, now: () => NOW, policy });
const root = (over: Partial<MintRequest> = {}): MintRequest => ({
  taskId: "root",
  issuedTo: "agent",
  effects: ["db.read", "db.write"],
  leases: { w: { ceiling: 10, effects: ["db.write"] } },
  ttlMs: 1000,
  ...over,
});
const child = (taskId: string, ceiling: number, over: Partial<MintRequest> = {}): MintRequest => ({
  taskId,
  issuedTo: "agent",
  effects: ["db.write"],
  leases: { w: { ceiling, effects: ["db.write"] } },
  ttlMs: 1000,
  parent: { taskId: "root" },
  ...over,
});
const renewal = (epoch = 0, over: Partial<RenewalRequest> = {}): RenewalRequest => ({
  taskId: "root",
  epoch,
  spent: { w: 3 },
  renewals: 0,
  ...over,
});

describe("InMemoryGrantBroker mint", () => {
  it("mints a verifiable root", async () => {
    const g = await mk().mint(root());
    expect(g).toMatchObject({ taskId: "root", rootId: "root", epoch: 0, exp: NOW + 1000 });
    expect(g.parentId).toBeUndefined();
    expect(verifyTaskGrant(SECRET, g)).toBeDefined();
  });
  it("mints a child inheriting rootId", async () => {
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
  it("refuses a ceiling over the parent's headroom, including two children together", async () => {
    const b = mk();
    await b.mint(root());
    await expect(b.mint(child("c0", 11))).rejects.toThrow(/headroom/);
    await b.mint(child("c1", 6));
    await expect(b.mint(child("c2", 5))).rejects.toThrow(/headroom/);
    await b.mint(child("c3", 4));
  });
  it("refuses a duplicate taskId and a bad ttl", async () => {
    const b = mk();
    await b.mint(root());
    await expect(b.mint(root())).rejects.toThrow(/duplicate/);
    await expect(b.mint(root({ taskId: "r2", ttlMs: 0 }))).rejects.toThrow(/ttlMs/);
  });
  it("copies the request: later mutation does not change the stored grant", async () => {
    const b = mk();
    const req = root();
    await b.mint(req);
    req.effects.push("net.out");
    req.leases.w!.ceiling = 999;
    const g = await b.current("root");
    expect(g?.effects).toEqual(["db.read", "db.write"]);
    expect(g?.leases.w?.ceiling).toBe(10);
    (g as { effects: string[] }).effects.push("zzz");
    expect((await b.current("root"))?.effects).toHaveLength(2);
  });
});

describe("InMemoryGrantBroker renew", () => {
  it("increments the epoch, changes the digest, keeps the old digest unrevoked", async () => {
    const b = mk();
    const g0 = await b.mint(root());
    const v = await b.renew(renewal());
    expect(v).toMatchObject({ granted: true, epoch: 1 });
    const g1 = await b.current("root");
    expect(g1?.epoch).toBe(1);
    expect(verifyTaskGrant(SECRET, g1 as never)).toBeDefined();
    expect(v.digest).toBe(taskGrantDigest(g1 as never));
    expect(v.digest).not.toBe(taskGrantDigest(g0));
    expect(await b.revoked(taskGrantDigest(g0))).toBe(false);
    expect(g1?.effects).toEqual(g0.effects);
  });
  it("refuses a stale epoch and an unknown task", async () => {
    const b = mk();
    await b.mint(root());
    await b.renew(renewal(0));
    expect((await b.renew(renewal(0))).granted).toBe(false);
    expect((await b.renew(renewal(1, { taskId: "nope" }))).granted).toBe(false);
  });
  it("default policy allows 8 renewals, then denies", async () => {
    const b = mk();
    await b.mint(root());
    for (let i = 0; i < 8; i++) expect((await b.renew(renewal(i))).granted).toBe(true);
    expect((await b.renew(renewal(8))).granted).toBe(false);
  });
  it("a policy returning false denies", async () => {
    const b = mk(() => false);
    await b.mint(root());
    const v = await b.renew(renewal());
    expect(v.granted).toBe(false);
    expect((await b.current("root"))?.epoch).toBe(0);
  });
  it("a policy can set new ceilings but not add a lease", async () => {
    const b = mk((_r, _h) => ({ leases: { w: 20 } }));
    await b.mint(root());
    expect((await b.renew(renewal())).granted).toBe(true);
    expect((await b.current("root"))?.leases.w?.ceiling).toBe(20);
    const b2 = mk(() => ({ leases: { extra: 5 } }));
    await b2.mint(root());
    const v = await b2.renew(renewal());
    expect(v.granted).toBe(false);
    expect(v.reason).toMatch(/extra/);
    expect((await b2.current("root"))?.epoch).toBe(0);
  });
  it("a child's new ceiling is bounded by the parent's headroom", async () => {
    const b = mk(() => ({ leases: { w: 9 } }));
    await b.mint(root());
    await b.mint(child("c1", 4));
    await b.mint(child("c2", 4));
    const v = await b.renew(renewal(0, { taskId: "c1" }));
    expect(v.granted).toBe(false);
    expect(v.reason).toMatch(/headroom/);
  });
  it("passes the policy the broker's own renewal count and the spend", async () => {
    const seen: unknown[] = [];
    const b = mk((_r, h) => {
      seen.push(h);
      return {};
    });
    await b.mint(root());
    await b.renew(renewal(0, { renewals: 99 }));
    expect(seen).toEqual([{ renewals: 0, spentSoFar: { w: 3 } }]);
  });
  it("wraps an untainted justification and keeps a tainted one's origin", async () => {
    let got: unknown;
    const b = mk((r) => {
      got = r.justification;
      return {};
    });
    await b.mint(root());
    await b.renew(renewal(0, { justification: "need more" }));
    expect(isTainted(got)).toBe(false); // the policy sees the request as given, never an unwrapped decision
    expect(got).toBe("need more");
    const kept = (b as unknown as { tasks: Map<string, { justifications: unknown[] }> }).tasks.get(
      "root"
    )!.justifications;
    expect(taintOf(kept[0])?.origin).toBe("task-authority:renewal");
    await b.renew(renewal(1, { justification: tainted("x", "mcp:srv") }));
    expect(taintOf(kept[1])?.origin).toBe("mcp:srv");
  });
  it("refuses oversize or non-string justification and other out-of-bounds input", async () => {
    const b = mk();
    await b.mint(root());
    const bad: Partial<RenewalRequest>[] = [
      { justification: "x".repeat(4097) },
      { justification: 5 as never },
      { justification: tainted("x".repeat(4097), "o") },
      { spent: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 1])) },
      { spent: { w: -1 } },
      { spent: { w: Number.NaN } },
      { effectClassesCaused: Array.from({ length: 33 }, () => "a") },
      { effectClassesCaused: ["a".repeat(65)] },
    ];
    for (const o of bad) expect((await b.renew(renewal(0, o))).granted).toBe(false);
    expect((await b.current("root"))?.epoch).toBe(0);
  });
});

describe("InMemoryGrantBroker revoke", () => {
  it("hides current, revokes every past digest, cascades, and is idempotent", async () => {
    const b = mk();
    const g0 = await b.mint(root());
    const c = await b.mint(child("c1", 4));
    await b.renew(renewal());
    const g1 = (await b.current("root")) as never;
    await b.revoke("root", "bye");
    await b.revoke("root", "bye");
    expect(await b.current("root")).toBeUndefined();
    expect(await b.current("c1")).toBeUndefined();
    for (const g of [g0, g1, c]) expect(await b.revoked(taskGrantDigest(g))).toBe(true);
    expect((await b.renew(renewal(1))).granted).toBe(false);
  });
});
