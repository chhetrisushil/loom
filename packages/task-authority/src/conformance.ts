import type {
  Check,
  ConformanceReport,
  ConformanceResult,
  ConformanceSubject,
} from "./conformanceKit";
import { clock, mintReq, mk, must, refused } from "./conformanceKit";
import { taskGrantDigest } from "./grant";

export type {
  CheckStatus,
  ConformanceReport,
  ConformanceResult,
  ConformanceSubject,
} from "./conformanceKit";

/** Every check id, in run order (ADR 0150 D14 plus the broker-contract and ruling checks). */
export const CONFORMANCE_CHECK_IDS = [
  "broker.claim-atomic",
  "broker.holder-pure",
  "broker.take-return-once",
  "broker.revoked-covers-past-digests",
  "broker.mint-subset-headroom",
  "broker.mint-parent-reserved",
  "broker.renew-stale-epoch",
  "broker.renew-born-expired",
  "broker.reservation-never-released",
  "carve.child-renew-ceiling",
  "laundering.uncovered.a2a",
  "laundering.covered",
] as const;

const CHECKS: Record<string, Check> = {
  "broker.claim-atomic": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("t", 1));
    const wins = (
      await Promise.all(Array.from({ length: 20 }, (_, i) => b.claim("t", `e${i}`)))
    ).filter(Boolean);
    must(
      wins.length === 1,
      `${wins.length} of 20 concurrent claims won; claim must be an atomic compare-and-set`
    );
    must(
      await b.claim("t", (await b.holder("t")) as string),
      "a repeat claim by the holder must be true"
    );
  },
  "broker.holder-pure": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("t", 1));
    must((await b.holder("t")) === undefined, "holder() must be undefined before any claim");
    must(
      (await b.claim("t", "e2")) && (await b.holder("t")) === "e2",
      "holder() must report the claimant"
    );
    must(!(await b.claim("t", "e3")), "holder() or a later claim changed the binding");
  },
  "broker.take-return-once": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 4));
    await b.mint(mintReq("c", 4, "p"));
    await b.settleChild("c", { w: 1 });
    must(
      Object.keys(await b.takeReturn("c", "other-parent")).length === 0,
      "a wrong parent took a return"
    );
    const first = await b.takeReturn("c", "p");
    must(first.w === 3, `first takeReturn gave ${JSON.stringify(first)}, expected {"w":3}`);
    const second = await b.takeReturn("c", "p");
    must(Object.keys(second).length === 0, `takeReturn paid twice: ${JSON.stringify(second)}`);
  },
  "broker.revoked-covers-past-digests": async (s) => {
    const b = mk(s, () => ({}));
    const g0 = await b.mint(mintReq("t", 2));
    const v = await b.renew({ taskId: "t", epoch: 0, spent: {}, renewals: 0 });
    must(v.granted, "setup: renewal was not granted");
    await b.revoke("t", "kit");
    must(b.revoked !== undefined, "no revoked(): revocation cannot be checked");
    must(await b.revoked?.(taskGrantDigest(g0)), "revoked() forgot a past digest (epoch 0)");
    must(
      await b.revoked?.((v as { digest: string }).digest),
      "revoked() missed the current digest"
    );
  },
  "broker.mint-subset-headroom": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 4));
    must(
      await refused(b.mint({ ...mintReq("x1", 1, "p"), effects: ["act", "other"] })),
      "a child with an effect the parent lacks was minted"
    );
    must(
      await refused(
        b.mint({ ...mintReq("x2", 1, "p"), leases: { z: { ceiling: 1, effects: ["act"] } } })
      ),
      "a child lease the parent lacks was minted"
    );
    await b.mint(mintReq("c1", 3, "p"));
    must(
      await refused(b.mint(mintReq("c2", 2, "p"))),
      "children's ceilings (3 + 2) exceeded the parent's 4"
    );
  },
  "broker.mint-parent-reserved": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 6));
    const forged = { ...mintReq("c", 4, "p"), parentReserved: { w: 2 } };
    must(
      await refused(b.mint(forged)),
      "a mint beyond what the parent reserved in its fold (R25) was accepted"
    );
  },
  "broker.renew-stale-epoch": async (s) => {
    const b = mk(s, () => ({}));
    await b.mint(mintReq("t", 2));
    must(
      (await b.renew({ taskId: "t", epoch: 0, spent: {}, renewals: 0 })).granted,
      "setup: first renewal denied"
    );
    must(
      !(await b.renew({ taskId: "t", epoch: 0, spent: {}, renewals: 1 })).granted,
      "a renewal at a stale epoch was granted"
    );
  },
  "broker.renew-born-expired": async (s) => {
    const c = clock();
    const b = mk(s, () => ({}), c);
    await b.mint({ ...mintReq("p", 4), ttlMs: 1_000 });
    await b.mint({ ...mintReq("c", 2, "p"), ttlMs: 1_000 });
    c.t += 5_000;
    const v = await b.renew({ taskId: "c", epoch: 0, spent: {}, renewals: 0 });
    must(
      !v.granted,
      "a child of an expired parent was renewed to a grant that is already expired (R12)"
    );
  },
  "broker.reservation-never-released": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 4));
    await b.mint(mintReq("c1", 4, "p"));
    await b.revoke("c1", "kit");
    must(
      await refused(b.mint(mintReq("c2", 1, "p"))),
      "a revoked child's reservation was released (R7/R11)"
    );
  },
  "carve.child-renew-ceiling": async (s) => {
    const b = mk(s, () => ({ leases: { w: 3 } }));
    await b.mint(mintReq("p", 6));
    await b.mint(mintReq("c", 2, "p"));
    const v = await b.renew({ taskId: "c", epoch: 0, spent: {}, renewals: 0 });
    must(!v.granted, "a child renewed above the ceiling it was minted with (R25)");
  },
  "laundering.uncovered.a2a": async () => "skipped:A2A transport not available in-process",
  "laundering.covered": async () => "skipped:slice 2 (ADR 0150 D7)",
};

/** Run every check against `subject`. Never throws: a failing check is reported with its message. */
export async function checkTaskAuthorityConformance(
  subject: ConformanceSubject
): Promise<ConformanceReport> {
  const results: ConformanceResult[] = [];
  for (const id of CONFORMANCE_CHECK_IDS) {
    try {
      const r = await (CHECKS[id] as Check)(subject);
      results.push(
        typeof r === "string"
          ? { id, status: "skipped", message: r.slice("skipped:".length) }
          : { id, status: "passed" }
      );
    } catch (e) {
      results.push({ id, status: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok: results.every((r) => r.status !== "failed"), results };
}
