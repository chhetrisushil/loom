import { describe, expect, it } from "vitest";
import { GrantBrokerError, type MintRequest } from "./broker";
import { childGrantMinter } from "./childLease";
import { checkTaskAuthorityConformance } from "./conformance";
import type { ConformanceSubject } from "./conformanceKit";
import {
  READS_MAX_STARS,
  READS_MAX_TOTAL,
  type TaskGrant,
  type UnsignedTaskGrant,
  globCovers,
  signTaskGrant,
  taskGrantDigest,
  validateGrantShape,
  verifyTaskGrant,
  widensReadsOrSandbox,
} from "./grant";
import { InMemoryGrantBroker } from "./renew";

const S = "golden-secret";
const clock = () => 1_000;
const mint = (id: string, extra: Partial<MintRequest> = {}, parent?: string): MintRequest => ({
  taskId: id,
  issuedTo: id,
  effects: ["x"],
  leases: { w: { ceiling: 4, effects: ["x"] } },
  ttlMs: 60_000,
  ...(parent !== undefined && { parent: { taskId: parent } }),
  ...extra,
});
const unsigned = (extra: Partial<UnsignedTaskGrant> = {}): UnsignedTaskGrant => ({
  taskId: "t",
  rootId: "t",
  issuedTo: "a",
  effects: ["x"],
  leases: {},
  exp: 5000,
  epoch: 0,
  ...extra,
});

describe("S-R4 signed encoding", () => {
  // Vectors MINTED BEFORE this change (ADR 0150 S-R4): a grant without the new fields must not move.
  it("a grant without reads/sandbox keeps its pre-change signature and digest byte for byte", () => {
    const g = signTaskGrant(S, {
      taskId: "t",
      rootId: "t",
      issuedTo: "a",
      effects: ["x", "y:z"],
      leases: { w: { ceiling: 3, effects: ["x"] } },
      exp: 5000,
      epoch: 2,
    });
    expect(g.sig).toBe("9f9e7818249c472a4e3fbbdadc1b5a570bd83d21b4048fdaf855689895291706");
    expect(taskGrantDigest(g)).toBe(
      "7e1d9a4d900db66fcde760b55a762bc49328fe20e88d1cd9ec3a096aef121668"
    );
    const id = signTaskGrant(S, {
      taskId: "c",
      rootId: "t",
      parentId: "t",
      issuedTo: "a",
      tenant: "acme",
      onBehalfOf: "u",
      effects: ["x"],
      leases: {},
      exp: 5000,
      epoch: 0,
    });
    expect(id.sig).toBe("984e1cc7a90a9f94d8d2ed50f518711a3a1d8ee72263113528cf2f51ee1d381d");
    expect(taskGrantDigest(id)).toBe(
      "8c0e79a0ef7df22c5b364fcbc73a1696de40453a1f2bbb7019f6b9da839b25d1"
    );
  });

  it("the fields change the signature and digest, and reads order does not", () => {
    const plain = signTaskGrant(S, unsigned());
    const a = signTaskGrant(S, unsigned({ reads: ["m:*", "d:a"], sandbox: "isolated" }));
    const b = signTaskGrant(S, unsigned({ reads: ["d:a", "m:*"], sandbox: "isolated" }));
    expect(a.sig).not.toBe(plain.sig);
    expect(a.sig).toBe(b.sig);
    expect(signTaskGrant(S, unsigned({ reads: [] })).sig).not.toBe(plain.sig);
    expect(taskGrantDigest(a)).not.toBe(taskGrantDigest(plain));
  });

  // kills: an encoder that leaves reads out of the signed bytes
  it("a tampered reads fails verification (widened, added, emptied)", () => {
    const g = signTaskGrant(S, unsigned({ reads: ["m:a"] }));
    expect(verifyTaskGrant(S, g)?.reads).toEqual(["m:a"]);
    expect(verifyTaskGrant(S, { ...g, reads: ["m:*"] })).toBeUndefined();
    expect(verifyTaskGrant(S, { ...g, reads: [] })).toBeUndefined();
    const { reads: _r, ...stripped } = g;
    expect(verifyTaskGrant(S, stripped as TaskGrant)).toBeUndefined();
    const none = signTaskGrant(S, unsigned());
    expect(verifyTaskGrant(S, { ...none, reads: ["m:a"] })).toBeUndefined();
  });

  // kills: an encoder that leaves sandbox out of the signed bytes
  it("stripping or adding sandbox fails verification", () => {
    const g = signTaskGrant(S, unsigned({ sandbox: "isolated" }));
    const { sandbox: _s, ...stripped } = g;
    expect(verifyTaskGrant(S, stripped as TaskGrant)).toBeUndefined();
    const none = signTaskGrant(S, unsigned());
    expect(verifyTaskGrant(S, { ...none, sandbox: "isolated" })).toBeUndefined();
  });
});

describe("S-R4 shape", () => {
  // kills: a validator that still rejects the keys, or one that accepts anything
  it("accepts well-formed fields and rejects bad ones", () => {
    expect(() =>
      validateGrantShape(unsigned({ reads: ["m:*"], sandbox: "isolated" }))
    ).not.toThrow();
    const bad = (extra: Record<string, unknown>) =>
      expect(() => validateGrantShape(unsigned(extra as never))).toThrow();
    bad({ reads: "m:a" });
    bad({ reads: [1] });
    bad({ reads: [""] });
    bad({ reads: ["*"] });
    bad({ reads: ["**"] }); // universal patterns: every entry needs a literal tool id first
    bad({ reads: ["*:*"] });
    bad({ reads: [":*"] });
    bad({ reads: ["mem*:a"] });
    bad({ reads: ["mem"] });
    bad({ reads: ["m:a*b*c*d*e*"] }); // 5 stars
    bad({ reads: ["m:a", "m:a"] }); // duplicate
    bad({ reads: ["m:\u0085a"] }); // C1
    bad({ reads: ["m:\u2028a"] });
    bad({ reads: ["m:\u202ea"] }); // bidi override
    bad({ reads: ["m:\u2067a"] });
    bad({ reads: Array.from({ length: 33 }, (_, i) => `m:${"x".repeat(500)}${i}`) }); // over READS_MAX_TOTAL
    bad({ reads: ["m:\u0000a"] });
    bad({ reads: ["m".repeat(513)] });
    bad({ reads: Array.from({ length: 257 }, (_, i) => `m:${i}`) });
    bad({ sandbox: "none" });
    bad({ sandbox: true });
    bad({ ambient: "none" });
  });
});

describe("globCovers", () => {
  it("is exposed on the package index as the reference subset check", async () => {
    const idx = await import("./index");
    expect(idx.globCovers).toBe(globCovers);
    expect(idx.widensReadsOrSandbox).toBe(widensReadsOrSandbox);
  });
  it("is sound and conservative", () => {
    expect(globCovers("m:*", "m:a")).toBe(true);
    expect(globCovers("m:*", "m:a*")).toBe(true);
    expect(globCovers("m:a", "m:a")).toBe(true);
    expect(globCovers("m:a", "m:*")).toBe(false); // narrower parent never covers a wider child
    expect(globCovers("m:*", "n:a")).toBe(false);
    expect(globCovers("m*", "m:a")).toBe(true);
    expect(globCovers("a*b*c", "aXbYc")).toBe(true);
    expect(globCovers("a*b*c", "aXbY")).toBe(false);
    expect(globCovers("m.a", "mXa")).toBe(false); // `.` is literal
  });
  // kills: a matcher whose cost is not bounded by the caps (the reviewer's 58 KB parent cost 2.85 s of CPU)
  it("a list at the caps costs at most O(total^2) steps (counted, not timed)", () => {
    const stars = "a*".repeat(READS_MAX_STARS - 1);
    const mkList = (tail: string) =>
      Array.from(
        { length: 32 },
        (_, i) => `m:${stars}${"a".repeat(200)}${tail}${String(i).padStart(3, "0")}`
      );
    const parent = mkList("b");
    const child = Array.from(
      { length: 32 },
      (_, i) => `m:${"a".repeat(480)}${String(i).padStart(3, "0")}`
    );
    for (const l of [parent, child])
      expect(() => validateGrantShape(unsigned({ reads: l }))).not.toThrow();
    const meter = { steps: 0 };
    expect(widensReadsOrSandbox({ reads: parent }, { reads: child }, meter)).toMatch(/exceeds/);
    const sum = (l: string[]) => l.reduce((n, r) => n + r.length, 0);
    expect(meter.steps).toBeGreaterThan(0);
    expect(meter.steps).toBeLessThanOrEqual(sum(parent) * sum(child)); // <= READS_MAX_TOTAL^2
    expect(sum(parent) * sum(child)).toBeLessThanOrEqual(READS_MAX_TOTAL ** 2);
  });
});

describe("S-R4 broker", () => {
  const mk = () => new InMemoryGrantBroker({ secret: S, now: clock, policy: () => ({}) });

  it("carries the fields to a child within the parent's scope", async () => {
    const b = mk();
    await b.mint(mint("p", { reads: ["m:*"], sandbox: "isolated" }));
    const c = await b.mint(mint("c", { reads: ["m:a"], sandbox: "isolated" }, "p"));
    expect(c.reads).toEqual(["m:a"]);
    expect(c.sandbox).toBe("isolated");
    expect(verifyTaskGrant(S, c)).toBeDefined();
  });

  // kills: a subset check that is missing, or compares by string equality only, or ignores an absent parent
  it("refuses a child that widens reads", async () => {
    const b = mk();
    await b.mint(mint("p", { reads: ["m:a"] }));
    await expect(b.mint(mint("c1", { reads: ["m:*"] }, "p"))).rejects.toThrow(GrantBrokerError);
    await expect(b.mint(mint("c2", { reads: ["n:a"] }, "p"))).rejects.toThrow(/exceeds the parent/);
    await b.mint(mint("free"));
    await expect(b.mint(mint("c3", { reads: ["m:a"] }, "free"))).rejects.toThrow(/exceeds/);
    await b.mint(mint("c4", {}, "free")); // no reads is always a subset
  });

  // kills: a broker that lets an isolated task spawn a non-isolated child
  it("refuses a non-isolated child of an isolated parent", async () => {
    const b = mk();
    await b.mint(mint("p", { sandbox: "isolated" }));
    await expect(b.mint(mint("c", {}, "p"))).rejects.toThrow(/must be isolated/);
    await b.mint(mint("c2", { sandbox: "isolated" }, "p"));
    await b.mint(mint("q")); // an isolated child of a plain parent is a narrowing: allowed
    await b.mint(mint("c3", { sandbox: "isolated" }, "q"));
  });

  // kills: a renewal that rebuilds the grant without the new fields
  it("renewal keeps reads and sandbox, and the renewed grant verifies", async () => {
    const b = mk();
    await b.mint(mint("p", { reads: ["m:*"], sandbox: "isolated" }));
    const v = await b.renew({ taskId: "p", epoch: 0, spent: {}, renewals: 0 });
    expect(v.granted).toBe(true);
    const g = (await b.current("p")) as TaskGrant;
    expect(g.epoch).toBe(1);
    expect(g.reads).toEqual(["m:*"]);
    expect(g.sandbox).toBe("isolated");
    expect(verifyTaskGrant(S, g)).toBeDefined();
  });

  // kills: a child minter that mints children without the parent's scope
  it("childGrantMinter inherits the parent's reads and sandbox", async () => {
    const b = mk();
    await b.mint(mint("p", { reads: ["m:*"], sandbox: "isolated" }));
    await b.claim("p", "pe");
    await b.reserve("p", "pe::k", { w: 2 });
    const m = childGrantMinter(b, { ttlMs: 10_000, now: clock });
    const r = await m.mintChildGrant(
      { executionId: "pe", taskId: "p", resources: { "lease.w.reserved": 2 } },
      { childId: "pe::k", lease: { w: 2 } }
    );
    expect(r.taskGrant.reads).toEqual(["m:*"]);
    expect(r.taskGrant.sandbox).toBe("isolated");
  });
});

describe("S-R4 conformance", () => {
  const subject = (
    B: new (o: ConstructorParameters<typeof InMemoryGrantBroker>[0]) => InMemoryGrantBroker
  ): ConformanceSubject => ({
    makeBroker: (o) => new B(o),
  });
  const verdict = async (B: Parameters<typeof subject>[0]) =>
    (await checkTaskAuthorityConformance(subject(B))).results.find(
      (r) => r.id === "broker.reads-sandbox"
    );

  it("passes the reference broker", async () => {
    expect((await verdict(InMemoryGrantBroker))?.status).toBe("passed");
  }, 30_000);

  class DropsOnRenew extends InMemoryGrantBroker {
    override async renew(r: Parameters<InMemoryGrantBroker["renew"]>[0]) {
      const v = await super.renew(r);
      const rec = this.tasks.get(r.taskId);
      if (rec) {
        const { sig: _s, reads: _r, sandbox: _b, ...body } = rec.grant;
        rec.grant = signTaskGrant(this.secret, body);
      }
      return v;
    }
  }
  class DropsOnChild extends InMemoryGrantBroker {
    override async mint(r: MintRequest) {
      if (r.parent === undefined) return super.mint(r);
      const g = await super.mint(r);
      const { sig: _s, reads: _r, sandbox: _b, ...body } = g;
      const bare = signTaskGrant(this.secret, body);
      const rec = this.tasks.get(r.taskId);
      if (rec) rec.grant = bare;
      return bare;
    }
  }
  class AcceptsWidening extends InMemoryGrantBroker {
    override async mint(r: MintRequest) {
      if (r.parent === undefined) return super.mint(r);
      const p = this.tasks.get(r.parent.taskId)?.grant;
      // mint under the parent's own (always valid) scope, then re-sign with what the caller asked for
      const g = await super.mint({
        ...r,
        ...(p?.reads !== undefined && { reads: p.reads }),
        ...(p?.sandbox !== undefined && { sandbox: p.sandbox }),
      });
      const { sig: _s, reads: _r, sandbox: _b, ...body } = g;
      const wide = signTaskGrant(this.secret, {
        ...body,
        ...(r.reads !== undefined && { reads: r.reads }),
        ...(r.sandbox !== undefined && { sandbox: r.sandbox }),
      });
      const rec = this.tasks.get(r.taskId);
      if (rec) rec.grant = wide;
      return wide;
    }
  }

  // kills: a coverage test that is symmetric (accepts a wider child when the parent is covered by it)
  class BothDirections extends InMemoryGrantBroker {
    override async mint(r: MintRequest) {
      const p = r.parent && this.tasks.get(r.parent.taskId)?.grant;
      const ok =
        p &&
        r.reads?.every((c) => (p.reads ?? []).some((q) => globCovers(q, c) || globCovers(c, q)));
      if (!ok) return super.mint(r);
      const g = await super.mint({ ...r, reads: p.reads as string[] });
      const { sig: _s, reads: _r, ...body } = g;
      const wide = signTaskGrant(this.secret, { ...body, reads: r.reads as string[] });
      const rec = this.tasks.get(r.taskId);
      if (rec) rec.grant = wide;
      return wide;
    }
  }
  // kills: a broker that widens a CHILD on renewal (here: to the parent's reads, dropping sandbox)
  class WidensChildOnRenew extends InMemoryGrantBroker {
    override async renew(r: Parameters<InMemoryGrantBroker["renew"]>[0]) {
      const v = await super.renew(r);
      const rec = this.tasks.get(r.taskId);
      const par = rec?.parent && this.tasks.get(rec.parent)?.grant;
      if (rec && par) {
        const { sig: _s, reads: _r, ...body } = rec.grant;
        rec.grant = signTaskGrant(this.secret, { ...body, reads: par.reads as string[] });
      }
      return v;
    }
  }
  it("fails a broker whose coverage test is symmetric", async () => {
    const v = await verdict(BothDirections);
    expect(v?.status).toBe("failed");
    expect(v?.message).toMatch(/reads mem:\* was minted/);
  }, 30_000);
  it("fails a broker that widens a child on renewal", async () => {
    const v = await verdict(WidensChildOnRenew);
    expect(v?.status).toBe("failed");
    expect(v?.message).toMatch(/child renewal dropped or changed/);
  }, 30_000);
  it("fails a broker that drops reads/sandbox on renewal", async () => {
    const v = await verdict(DropsOnRenew);
    expect(v?.status).toBe("failed");
    expect(v?.message).toMatch(/renewal dropped/);
  }, 30_000);
  it("fails a broker that drops reads/sandbox on a child", async () => {
    const v = await verdict(DropsOnChild);
    expect(v?.status).toBe("failed");
    expect(v?.message).toMatch(/did not carry/);
  }, 30_000);
  it("fails a broker that accepts a widening child", async () => {
    const v = await verdict(AcceptsWidening);
    expect(v?.status).toBe("failed");
    expect(v?.message).toMatch(/was minted/);
  }, 30_000);
});
