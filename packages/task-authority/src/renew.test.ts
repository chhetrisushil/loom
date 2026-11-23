import { isTainted, taintOf, tainted } from "@loomwork/classify";
import { describe, expect, it } from "vitest";
import type { MintRequest, RenewalRequest } from "./broker";
import { taskGrantDigest, verifyTaskGrant } from "./grant";
import { InMemoryGrantBroker, type RenewalPolicy } from "./renew";

const SECRET = "s3cret";
const NOW = 1_000_000;
const mk = (policy?: RenewalPolicy, clock: { t: number } = { t: NOW }) =>
  new InMemoryGrantBroker({ secret: SECRET, now: () => clock.t, policy });
const root = (over: Partial<MintRequest> = {}): MintRequest => ({
  taskId: "root",
  issuedTo: "agent",
  effects: ["db.read", "db.write"],
  leases: { w: { ceiling: 10, effects: ["db.write"] } },
  ttlMs: 1000,
  ...over,
});
const child = (taskId: string, ceiling: number, parent = "root"): MintRequest => ({
  taskId,
  issuedTo: "agent",
  effects: ["db.write"],
  leases: { w: { ceiling, effects: ["db.write"] } },
  ttlMs: 1000,
  parent: { taskId: parent },
});
const renewal = (epoch = 0, over: Partial<RenewalRequest> = {}): RenewalRequest => ({
  taskId: "root",
  epoch,
  spent: { w: 3 },
  renewals: 0,
  ...over,
});
const setTo =
  (n: number): RenewalPolicy =>
  () => ({ leases: { w: n } });
const granted = (v: { granted: boolean }) => v.granted;

describe("InMemoryGrantBroker renew", () => {
  it("increments the epoch, changes the digest, keeps scope, never revokes the old digest", async () => {
    const clock = { t: NOW };
    const b = mk(undefined, clock);
    const g0 = await b.mint(root());
    clock.t = NOW + 400;
    const v = await b.renew(renewal());
    expect(v).toMatchObject({ granted: true, epoch: 1 });
    const g1 = await b.current("root");
    expect(g1).toMatchObject({
      epoch: 1,
      exp: NOW + 400 + 1000,
      issuedTo: g0.issuedTo,
      rootId: g0.rootId,
      effects: g0.effects,
      leases: g0.leases,
    });
    expect(g1?.parentId).toBeUndefined();
    expect(verifyTaskGrant(SECRET, g1 as never)).toBeDefined();
    expect(v.granted && v.digest).toBe(taskGrantDigest(g1 as never));
    expect(v.granted && v.digest).not.toBe(taskGrantDigest(g0));
    expect(await b.revoked(taskGrantDigest(g0))).toBe(false);
  });
  it("refuses a stale epoch and an unknown task", async () => {
    const b = mk();
    await b.mint(root());
    await b.renew(renewal(0));
    expect(granted(await b.renew(renewal(0)))).toBe(false);
    expect(granted(await b.renew(renewal(1, { taskId: "nope" })))).toBe(false);
  });
  it("two concurrent renewals at one epoch: exactly one is granted", async () => {
    const b = mk();
    await b.mint(root());
    const vs = await Promise.all([b.renew(renewal(0)), b.renew(renewal(0))]);
    expect(vs.filter(granted)).toHaveLength(1);
    expect((await b.current("root"))?.epoch).toBe(1);
  });
  it("default policy allows 8 renewals, then denies", async () => {
    const b = mk();
    await b.mint(root());
    for (let i = 0; i < 8; i++) expect(granted(await b.renew(renewal(i)))).toBe(true);
    expect(granted(await b.renew(renewal(8)))).toBe(false);
  });
  it("a policy returning false, or garbage, or throwing, denies", async () => {
    for (const p of [
      () => false,
      () => Promise.resolve({}),
      () => null,
      () => 5,
      () => [],
      () => ({ leases: 5 }),
      () => {
        throw new Error("boom");
      },
    ]) {
      const b = mk(p as never);
      await b.mint(root());
      expect(granted(await b.renew(renewal()))).toBe(false);
      expect((await b.current("root"))?.epoch).toBe(0);
    }
  });
  it("a policy can reset a ceiling but cannot add a lease or effect", async () => {
    const b = mk(setTo(20));
    await b.mint(root());
    expect(granted(await b.renew(renewal()))).toBe(true);
    expect((await b.current("root"))?.leases.w?.ceiling).toBe(20);
    const b2 = mk(() => ({ leases: { extra: 5 }, effects: ["net.out"] }) as never);
    await b2.mint(root());
    const v = await b2.renew(renewal());
    expect(v).toMatchObject({ granted: false });
    expect(!v.granted && v.reason).toMatch(/extra/);
    expect((await b2.current("root"))?.effects).toEqual(["db.read", "db.write"]);
  });
  it("refuses lowering a lease below what the children hold (revoked ones included)", async () => {
    const b = mk(setTo(3));
    await b.mint(root());
    await b.mint(child("c1", 8));
    const v = await b.renew(renewal());
    expect(v).toMatchObject({ granted: false });
    expect(!v.granted && v.reason).toMatch(/children/);
    await b.revoke("c1", "x");
    expect(granted(await b.renew(renewal()))).toBe(false);
    const ok = mk(setTo(8));
    await ok.mint(root());
    await ok.mint(child("c1", 8));
    expect(granted(await ok.renew(renewal()))).toBe(true);
  });
  it("a child renews down or level, never above its minted (reserved) ceiling (R25)", async () => {
    const down = mk(setTo(3));
    await down.mint(root());
    await down.mint(child("c1", 4));
    expect(granted(await down.renew(renewal(0, { taskId: "c1" })))).toBe(true);
    const over = mk(setTo(5)); // there is parent headroom (6), but 5 was never reserved for c1
    await over.mint(root());
    await over.mint(child("c1", 4));
    const v = await over.renew(renewal(0, { taskId: "c1" }));
    expect(!v.granted && v.reason).toMatch(/minted/);
  });
  it("clamps a child's renewed exp to the parent's; an expired grant still renews", async () => {
    const clock = { t: NOW };
    const b = mk(undefined, clock);
    const p = await b.mint(root());
    await b.mint(child("c1", 4));
    clock.t = NOW + 600;
    expect(granted(await b.renew(renewal(0, { taskId: "c1" })))).toBe(true);
    expect((await b.current("c1"))?.exp).toBe(p.exp);
    clock.t = NOW + 5000; // root and child both expired
    expect(granted(await b.renew(renewal(0)))).toBe(true);
    expect((await b.current("root"))?.exp).toBe(NOW + 5000 + 1000);
  });
  it("refuses renewal after the task or an ancestor is revoked", async () => {
    const b = mk();
    await b.mint(root());
    await b.mint(child("c1", 4));
    await b.revoke("root", "bye");
    expect(granted(await b.renew(renewal(0, { taskId: "c1" })))).toBe(false);
    expect(granted(await b.renew(renewal(0)))).toBe(false);
  });
  it("revoking a three-level lineage covers every digest of the grandchild", async () => {
    const b = mk();
    await b.mint(root());
    await b.mint(child("c1", 6));
    const g0 = await b.mint(child("g1", 3, "c1"));
    await b.renew(renewal(0, { taskId: "g1" }));
    const g1 = (await b.current("g1")) as never;
    await b.revoke("root", "bye");
    for (const g of [g0, g1]) expect(await b.revoked(taskGrantDigest(g))).toBe(true);
    expect(await b.current("g1")).toBeUndefined();
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
  it("wraps an untainted justification, keeps a tainted origin, and keeps only the last 16", async () => {
    const b = mk(() => false);
    await b.mint(root());
    const kept = () =>
      (b as unknown as { tasks: Map<string, { justifications: unknown[] }> }).tasks.get("root")!
        .justifications;
    await b.renew(renewal(0, { justification: "need more" }));
    expect(isTainted(kept()[0])).toBe(true);
    expect(taintOf(kept()[0])?.origin).toBe("task-authority:renewal");
    await b.renew(renewal(0, { justification: tainted("x", "mcp:srv") }));
    expect(taintOf(kept()[1])?.origin).toBe("mcp:srv");
    for (let i = 0; i < 1000; i++) await b.renew(renewal(0, { justification: "y".repeat(4096) }));
    expect(kept()).toHaveLength(16);
  });
  it("refuses out-of-bounds or unserializable requests", async () => {
    const b = mk();
    await b.mint(root());
    const cyc: Record<string, unknown> = { ...renewal() };
    cyc.self = cyc;
    const bad: Partial<RenewalRequest>[] = [
      { justification: "x".repeat(4097) },
      { justification: 5 as never },
      { justification: tainted("x".repeat(4097), "o") },
      { spent: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 1])) },
      { spent: { w: -1 } },
      { spent: { w: Number.NaN } },
      { effectClassesCaused: Array.from({ length: 33 }, () => "a") },
      { effectClassesCaused: ["a".repeat(65)] },
      { effectClassesCaused: [1 as never] },
    ];
    for (const o of bad) expect(granted(await b.renew(renewal(0, o)))).toBe(false);
    expect(granted(await b.renew(cyc as never))).toBe(false);
    expect(granted(await b.renew({ ...renewal(), x: 1n } as never))).toBe(false);
    expect(granted(await b.renew(null as never))).toBe(false);
    expect((await b.current("root"))?.epoch).toBe(0);
  });
  it("a child's renewing down releases nothing (high-water reservation)", async () => {
    const b = mk(setTo(1));
    await b.mint(root());
    await b.mint(child("c1", 10));
    expect(granted(await b.renew(renewal(0, { taskId: "c1" })))).toBe(true);
    await expect(b.mint(child("c2", 9))).rejects.toThrow(/headroom/);
    const up = mk((r) => ({ leases: { w: r.epoch === 0 ? 1 : 10 } }));
    await up.mint(root());
    await up.mint(child("c1", 10));
    await up.renew(renewal(0, { taskId: "c1" }));
    expect(granted(await up.renew(renewal(1, { taskId: "c1" })))).toBe(true);
  });
  it("a renewal down releases nothing: the child's reservation stays its minted ceiling", async () => {
    const b = mk(setTo(1));
    await b.mint(root());
    await b.mint(child("c1", 4));
    await b.renew(renewal(0, { taskId: "c1" }));
    await expect(b.mint(child("c2", 7))).rejects.toThrow(/headroom/);
    await b.mint(child("c3", 2));
  });
  it("denies a child's renewal under an expired parent; the root's own expired renewal works", async () => {
    const clock = { t: NOW };
    const b = mk(undefined, clock);
    await b.mint(root());
    await b.mint(child("c1", 4));
    clock.t = NOW + 5000;
    const v = await b.renew(renewal(0, { taskId: "c1" }));
    expect(!v.granted && v.reason).toMatch(/expired/);
    expect((await b.current("c1"))?.epoch).toBe(0);
    expect(granted(await b.renew(renewal(0)))).toBe(true);
  });
  it("a policy that revokes the task cannot commit a renewal", async () => {
    const ref: { b?: InMemoryGrantBroker } = {};
    const b = mk(() => {
      void ref.b?.revoke("root", "reentrant");
      return {};
    });
    ref.b = b;
    const g0 = await b.mint(root());
    expect(granted(await b.renew(renewal()))).toBe(false);
    expect(await b.current("root")).toBeUndefined();
    const digests = (b as unknown as { tasks: Map<string, { digests: string[] }> }).tasks.get(
      "root"
    )!.digests;
    expect(digests).toEqual([taskGrantDigest(g0)]);
  });
  it("a policy mutating history.spentSoFar does not change stored state", async () => {
    const b = mk((_r, h) => {
      h.spentSoFar.w = 999;
      return {};
    });
    await b.mint(root());
    await b.renew(renewal());
    const spent = (b as unknown as { tasks: Map<string, { spent: unknown }> }).tasks.get(
      "root"
    )!.spent;
    expect(spent).toEqual({ w: 3 });
  });
  it("a non-numeric policy ceiling is denied with a clear reason", async () => {
    const b = mk(() => ({ leases: { w: "5" } }) as never);
    await b.mint(root());
    const v = await b.renew(renewal());
    expect(!v.granted && v.reason).toMatch(/must be a number/);
  });
});
