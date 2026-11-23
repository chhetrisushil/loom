import { describe, expect, it } from "vitest";
import type { MintRequest, RenewalRequest } from "./broker";
import {
  CONFORMANCE_CHECK_IDS,
  type ConformanceReport,
  type ConformanceSubject,
  checkTaskAuthorityConformance,
} from "./conformance";
import { launderingCovered, readScope } from "./conformanceRuntime";
import { keyRing, signTaskGrant } from "./grant";
import { InMemoryGrantBroker } from "./renew";

type Opts = ConstructorParameters<typeof InMemoryGrantBroker>[0];
const reference: ConformanceSubject = { makeBroker: (o) => new InMemoryGrantBroker(o) };
const broken = (Broken: new (o: Opts) => InMemoryGrantBroker): ConformanceSubject => ({
  makeBroker: (o) => new Broken(o),
});
const failed = (r: ConformanceReport) => r.results.filter((x) => x.status === "failed");
const find = (r: ConformanceReport, id: string) => r.results.find((x) => x.id === id);

/** `tasks`, `claims` and `revokedDigests` are protected on the ledger; a subclass reaches them. */
class NonAtomicClaim extends InMemoryGrantBroker {
  override async claim(taskId: string, executionId: string): Promise<boolean> {
    const held = this.claims.get(taskId);
    await Promise.resolve(); // read, yield, write: two callers both see "unclaimed"
    if (held === undefined) this.claims.set(taskId, executionId);
    return held === undefined || held === executionId;
  }
}
class NeverRefunds extends InMemoryGrantBroker {
  override async settleChild(taskId: string, spend: Record<string, number>): Promise<void> {
    await super.settleChild(taskId, spend);
    const r = this.tasks.get(taskId);
    if (r?.parent !== undefined && r.settled !== undefined && Object.keys(r.settled).length === 0)
      r.high = { ...r.minted }; // refund undone: the reservation stays whole
  }
}
class RefundsAndPays extends InMemoryGrantBroker {
  override async settleChild(taskId: string, spend: Record<string, number>): Promise<void> {
    await super.settleChild(taskId, spend);
    const r = this.tasks.get(taskId);
    if (r?.parent !== undefined && r.settled !== undefined && Object.keys(r.settled).length === 0)
      r.settled = { w: 9 }; // refunded headroom AND still takeable
  }
}
class RefundsUnclaimed extends InMemoryGrantBroker {
  override async settleChild(taskId: string, spend: Record<string, number>): Promise<void> {
    this.claims.set(taskId, "forced"); // settleChild trusts the caller: a never-started child is refunded
    await super.settleChild(taskId, spend);
  }
}
class RenewableAfterRefund extends InMemoryGrantBroker {
  override async settleChild(taskId: string, spend: Record<string, number>): Promise<void> {
    await super.settleChild(taskId, spend);
    const r = this.tasks.get(taskId);
    if (r !== undefined) {
      r.revoked = undefined; // the refund left the grant live and renewable
      r.settled = undefined;
    }
  }
}
class PaysTwice extends InMemoryGrantBroker {
  override async takeReturn(taskId: string, parentTaskId: string): Promise<Record<string, number>> {
    const r = this.tasks.get(taskId);
    return r?.parent === parentTaskId && r.settled !== undefined ? { ...r.settled } : {};
  }
}
/** R33: settleUnstarted ignores that the child already started (or was settled) and re-arms the whole take. */
class PaysBothPaths extends InMemoryGrantBroker {
  override async settleUnstarted(childId: string, parent: string): Promise<void> {
    await super.settleUnstarted(childId, parent);
    const v = this.reservations.get(childId);
    if (v?.parent === parent) Object.assign(v, { outcome: "unstarted", taken: false });
  }
}
/** R36 I1: compares parentReserved with the live (releasable) sum, not a never-decreasing total. */
class DecreasingSum extends InMemoryGrantBroker {
  override async mint(r: MintRequest) {
    if (r.parent) this.carved.delete(r.parent.taskId);
    return super.mint(r);
  }
}
/** R33 I2: leaves a minted, never-claimed grant live (and claimable). */
class NoRevoke extends InMemoryGrantBroker {
  override async revoke(taskId: string, reason: string): Promise<void> {
    if (reason !== "never started") await super.revoke(taskId, reason);
  }
}
/** R33 I2: reads "unclaimed", yields, then revokes: a claim can win in between. */
class NonAtomicUnstarted extends InMemoryGrantBroker {
  override async settleUnstarted(childId: string, parent: string): Promise<void> {
    if (!this.tasks.has(childId)) return super.settleUnstarted(childId, parent); // unminted: nothing to race
    const v = this.reservations.get(childId);
    const claimed = this.claims.has(childId);
    await Promise.resolve();
    if (!v || v.parent !== parent || v.outcome !== undefined || claimed) return;
    await this.revoke(childId, "never started");
    v.outcome = "unstarted";
  }
}
class ForgetsPastDigests extends InMemoryGrantBroker {
  override async revoked(digest: string): Promise<boolean> {
    return [...this.tasks.values()].some((r) => r.revoked && r.digests.at(-1) === digest);
  }
}
class ChildMayRise extends InMemoryGrantBroker {
  override async renew(r: RenewalRequest) {
    const rec = this.tasks.get(r.taskId);
    const parent = rec?.parent;
    if (rec) rec.parent = undefined; // the parent-bound ceiling check is skipped
    try {
      return await super.renew(r);
    } finally {
      if (rec) rec.parent = parent;
    }
  }
}
class DropsTenantOnRenew extends InMemoryGrantBroker {
  override async renew(r: RenewalRequest) {
    const v = await super.renew(r);
    const rec = this.tasks.get(r.taskId);
    if (rec) {
      const { sig: _s, tenant: _t, ...body } = rec.grant;
      rec.grant = signTaskGrant(this.secret, body);
    }
    return v;
  }
}
/** Lets a child of an identity-free parent take a tenant by re-signing the minted grant. */
class ChildMayNameTenant extends InMemoryGrantBroker {
  override async mint(r: MintRequest) {
    const parentFree =
      r.parent !== undefined && this.tasks.get(r.parent.taskId)?.grant.tenant === undefined;
    const { tenant, ...rest } = r;
    const g = await super.mint(parentFree ? rest : r);
    const rec = this.tasks.get(r.taskId);
    if (!parentFree || tenant === undefined || !rec) return g;
    const { sig: _s, ...body } = rec.grant;
    rec.grant = signTaskGrant(this.secret, { ...body, tenant });
    return rec.grant;
  }
}
class RenewsWithPreviousKey extends InMemoryGrantBroker {
  override async renew(r: RenewalRequest) {
    const v = await super.renew(r);
    const rec = this.tasks.get(r.taskId);
    if (rec) {
      const { sig: _s, ...body } = rec.grant;
      rec.grant = signTaskGrant(keyRing(this.secret).verify.at(-1) as string, body);
    }
    return v;
  }
}
class NeverRevokes extends InMemoryGrantBroker {
  override async revoked(): Promise<boolean> {
    return false;
  }
}
/** Mints a child beyond the parent's fold reservation: ignores \`parentReserved\`. */
class IgnoresParentReserved extends InMemoryGrantBroker {
  override async mint(r: MintRequest) {
    const { parentReserved: _ignored, ...rest } = r;
    this.reservations.delete(r.taskId); // R33's broker-side record would also refuse it: ignore that too
    return super.mint(rest);
  }
}
/** Reports a renewal as granted (epoch bumped) but never raises the ceiling: the policy is ignored. */
const stuckCeiling: ConformanceSubject = {
  makeBroker: ({ policy: _policy, ...o }) => new InMemoryGrantBroker({ ...o, policy: () => ({}) }),
};
class ReleasesOnRevoke extends InMemoryGrantBroker {
  override async revoke(taskId: string, reason: string): Promise<void> {
    await super.revoke(taskId, reason);
    const rec = this.tasks.get(taskId);
    if (rec) rec.high = {};
  }
}
describe("checkTaskAuthorityConformance", () => {
  it("passes the reference broker; only the A2A laundering check is skipped, with a reason", async () => {
    const r = await checkTaskAuthorityConformance(reference);
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.map((x) => x.id)).toEqual([...CONFORMANCE_CHECK_IDS]);
    expect(find(r, "laundering.covered")?.status).toBe("passed");
    expect(find(r, "laundering.uncovered.a2a")?.message).toBe(
      "A2A transport not available in-process"
    );
    const skipped = r.results.filter((x) => x.status === "skipped").map((x) => x.id);
    expect(skipped).toEqual(["laundering.uncovered.a2a"]);
    expect(r.results.filter((x) => x.status === "passed").length).toBe(
      CONFORMANCE_CHECK_IDS.length - 1
    );
  }, 30_000);

  it("names every ADR 0150 D14 check", () => {
    const ids = CONFORMANCE_CHECK_IDS.join(" ");
    for (const d14 of [
      "laundering.uncovered",
      "laundering.covered",
      "carve.",
      "pause-renew",
      "replay",
      "revocation",
    ])
      expect(ids).toContain(d14);
  });

  it("fails broker.signs-current-key for a broker that renews with a previous key (R31)", async () => {
    const r = await checkTaskAuthorityConformance(broken(RenewsWithPreviousKey));
    expect(find(r, "broker.signs-current-key")?.status).toBe("failed");
    expect(find(r, "broker.signs-current-key")?.message).toMatch(/not signed with the current key/);
  }, 30_000);

  it("fails carve.total-spend for a broker that ignores parentReserved", async () => {
    const r = await checkTaskAuthorityConformance(broken(IgnoresParentReserved));
    expect(find(r, "carve.total-spend")?.status).toBe("failed");
    expect(find(r, "carve.total-spend")?.message).toMatch(/beyond the parent's reservation/);
  }, 30_000);

  it("fails broker.identity-fixed for a broker that drops tenant on renewal", async () => {
    const r = await checkTaskAuthorityConformance(broken(DropsTenantOnRenew));
    expect(find(r, "broker.identity-fixed")?.status).toBe("failed");
    expect(find(r, "broker.identity-fixed")?.message).toMatch(/renewal dropped or changed/);
    expect(
      find(await checkTaskAuthorityConformance(reference), "broker.identity-fixed")?.status
    ).toBe("passed");
  }, 60_000);

  it("fails broker.identity-fixed for a broker that lets a child of an identity-free parent name a tenant", async () => {
    const r = await checkTaskAuthorityConformance(broken(ChildMayNameTenant));
    expect(find(r, "broker.identity-fixed")?.status).toBe("failed");
    expect(find(r, "broker.identity-fixed")?.message).toMatch(/identity-free parent/);
  }, 60_000);

  it("fails pause-renew for a renewal that is granted but leaves the ceiling", async () => {
    const r = await checkTaskAuthorityConformance(stuckCeiling);
    expect(find(r, "pause-renew")?.status).toBe("failed");
    expect(find(r, "pause-renew")?.message).toMatch(/did not resume the run to completion/);
  }, 30_000);

  // The fail-proof of the covered-laundering check: a stack WITHOUT `directedBy` lets B's covered, A-directed step
  // run with no attribution, and the check must say so. (Kills: a check that only asserts the effect ran.)
  it("laundering.covered fails a stack with no directedBy, and passes with it", async () => {
    await expect(launderingCovered(reference, false)).rejects.toThrow(/ran with no attribution/);
    await expect(launderingCovered(reference, true)).resolves.toBeUndefined();
  }, 30_000);

  // The fail-proof of reads.read-scope: a stack whose read effect is not declared a read lets a read outside `reads` run.
  it("reads.read-scope fails a stack that does not check reads, and passes with it", async () => {
    await expect(readScope(reference, false)).rejects.toThrow(/must be refused/);
    await expect(readScope(reference, true)).resolves.toBeUndefined();
  }, 30_000);

  it("the guard checks do not depend on the broker: a broken broker cannot fail them", async () => {
    const r = await checkTaskAuthorityConformance(broken(ReleasesOnRevoke));
    for (const id of [
      "carve.forged-meters",
      "laundering.uncovered.shared-memory",
      "reads.read-scope",
    ])
      expect(find(r, id)?.status).toBe("passed");
  }, 30_000);

  // The fail-proof: each broken broker must fail the NAMED check, with a message that says why.
  const cases: [string, new (o: Opts) => InMemoryGrantBroker, string, RegExp][] = [
    ["a non-atomic claim", NonAtomicClaim, "broker.claim-atomic", /concurrent claims won/],
    [
      "a settleUnstarted that also pays a started child",
      PaysBothPaths,
      "broker.unstarted-return",
      /changed the take|CLAIMED|paid again/,
    ],
    [
      "a parentReserved check against the decreasing sum",
      DecreasingSum,
      "broker.unstarted-return",
      /unreserved child was minted/,
    ],
    [
      "a settleUnstarted that leaves the minted grant live",
      NoRevoke,
      "broker.unstarted-return",
      /could still be claimed/,
    ],
    [
      "a settleUnstarted that is not atomic with claim",
      NonAtomicUnstarted,
      "broker.unstarted-return",
      /both started/,
    ],
    [
      "a broker that never refunds a fold-less parent",
      NeverRefunds,
      "broker.refund-foldless",
      /headroom/,
    ],
    ["a refund that is also takeable", RefundsAndPays, "broker.refund-foldless", /double count/],
    [
      "a settleChild that refunds a child that never started",
      RefundsUnclaimed,
      "broker.refund-guards",
      /unclaimed child was refunded/,
    ],
    [
      "a refund that leaves the child renewable",
      RenewableAfterRefund,
      "broker.refund-guards",
      /settled child renewed|stayed live/,
    ],
    ["a takeReturn that pays twice", PaysTwice, "broker.take-return-once", /paid twice/],
    [
      "a revoked() that knows only the current digest",
      ForgetsPastDigests,
      "broker.revoked-covers-past-digests",
      /forgot a past digest/,
    ],
    [
      "a child that may renew above its minted ceiling",
      ChildMayRise,
      "carve.child-renew-ceiling",
      /above its minted ceiling/,
    ],
    [
      "a revoked() that never reports a revocation",
      NeverRevokes,
      "revocation",
      /after the revoke ran/,
    ],
    [
      "a revoke that releases the reservation",
      ReleasesOnRevoke,
      "broker.reservation-never-released",
      /released/,
    ],
  ];
  for (const [name, Broken, id, message] of cases)
    it(`fails ${id} for ${name}`, async () => {
      const r = await checkTaskAuthorityConformance(broken(Broken));
      expect(r.ok).toBe(false);
      expect(find(r, id)?.status).toBe("failed");
      expect(find(r, id)?.message).toMatch(message);
    }, 30_000);
});
