import { describe, expect, it } from "vitest";
import type { RenewalRequest } from "./broker";
import {
  CONFORMANCE_CHECK_IDS,
  type ConformanceReport,
  type ConformanceSubject,
  checkTaskAuthorityConformance,
} from "./conformance";
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
class PaysTwice extends InMemoryGrantBroker {
  override async takeReturn(taskId: string, parentTaskId: string): Promise<Record<string, number>> {
    const r = this.tasks.get(taskId);
    return r?.parent === parentTaskId && r.settled !== undefined ? { ...r.settled } : {};
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
class ReleasesOnRevoke extends InMemoryGrantBroker {
  override async revoke(taskId: string, reason: string): Promise<void> {
    await super.revoke(taskId, reason);
    const rec = this.tasks.get(taskId);
    if (rec) rec.high = {};
  }
}
describe("checkTaskAuthorityConformance", () => {
  it("passes the reference broker; laundering-covered is skipped explicitly, A2A with a reason", async () => {
    const r = await checkTaskAuthorityConformance(reference);
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.map((x) => x.id)).toEqual([...CONFORMANCE_CHECK_IDS]);
    expect(find(r, "laundering.covered")).toEqual({
      id: "laundering.covered",
      status: "skipped",
      message: "slice 2 (ADR 0150 D7)",
    });
    expect(find(r, "laundering.uncovered.a2a")?.message).toBe(
      "A2A transport not available in-process"
    );
    const skipped = r.results.filter((x) => x.status === "skipped").map((x) => x.id);
    expect(skipped).toEqual(["laundering.uncovered.a2a", "laundering.covered"]);
    expect(r.results.filter((x) => x.status === "passed").length).toBe(
      CONFORMANCE_CHECK_IDS.length - 2
    );
  }, 30_000);

  // The fail-proof: each broken broker must fail the NAMED check, with a message that says why.
  const cases: [string, new (o: Opts) => InMemoryGrantBroker, string, RegExp][] = [
    ["a non-atomic claim", NonAtomicClaim, "broker.claim-atomic", /concurrent claims won/],
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
      /above the ceiling it was minted/,
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
