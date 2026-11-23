import type {
  Check,
  ConformanceReport,
  ConformanceResult,
  ConformanceSubject,
} from "./conformanceKit";
import { clock, mintReq, mk, must, mustRefuse, req } from "./conformanceKit";
import { MORE_CHECKS } from "./conformanceMore";
import { RUNTIME_CHECKS } from "./conformanceRuntime";
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
  "carve.total-spend",
  "carve.forged-meters",
  "laundering.uncovered.shared-memory",
  "laundering.uncovered.a2a",
  "laundering.covered",
  "pause-renew",
  "replay",
  "revocation",
] as const;

const CHECKS: Record<string, Check> = {
  ...RUNTIME_CHECKS,
  ...MORE_CHECKS,
  "broker.claim-atomic": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("t", 1));
    const all = await Promise.all(Array.from({ length: 20 }, (_, i) => b.claim("t", `e${i}`)));
    const wins = all.filter(Boolean).length;
    must(wins === 1, `${wins} of 20 concurrent claims won; claim must be an atomic CAS`);
    must(
      await b.claim("t", (await b.holder("t")) as string),
      "a repeat claim by the holder is true"
    );
  },
  "broker.holder-pure": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("t", 1));
    must((await b.holder("t")) === undefined, "holder() must be undefined before any claim");
    must((await b.claim("t", "e2")) && (await b.holder("t")) === "e2", "holder() != claimant");
    must(!(await b.claim("t", "e3")), "holder() or a later claim changed the binding");
  },
  "broker.take-return-once": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 4));
    await b.mint(mintReq("c", 4, "p"));
    await b.settleChild("c", { w: 1 });
    must(!Object.keys(await b.takeReturn("c", "other")).length, "a wrong parent took a return");
    const first = await b.takeReturn("c", "p");
    must(first.w === 3, `first takeReturn gave ${JSON.stringify(first)}, expected {"w":3}`);
    const second = await b.takeReturn("c", "p");
    must(!Object.keys(second).length, `takeReturn paid twice: ${JSON.stringify(second)}`);
  },
  "broker.revoked-covers-past-digests": async (s) => {
    const b = mk(s, () => ({}));
    const g0 = await b.mint(mintReq("t", 2));
    const v = await b.renew(req("t", 0, 0));
    must(v.granted && b.revoked, "setup: renewal not granted, or no revoked()");
    await b.revoke("t", "kit");
    must(await b.revoked?.(taskGrantDigest(g0)), "revoked() forgot a past digest (epoch 0)");
    must(await b.revoked?.((v as { digest: string }).digest), "revoked() missed the current one");
  },
  "broker.mint-subset-headroom": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 4));
    const wide = { ...mintReq("x1", 1, "p"), effects: ["act", "other"] };
    await mustRefuse(b.mint(wide), "a child with an effect the parent lacks was minted");
    const lacks = { ...mintReq("x2", 1, "p"), leases: { z: { ceiling: 1, effects: ["act"] } } };
    await mustRefuse(b.mint(lacks), "a child lease the parent lacks was minted");
    await b.mint(mintReq("c1", 3, "p"));
    await mustRefuse(b.mint(mintReq("c2", 2, "p")), "children's ceilings (3 + 2) exceeded 4");
  },
  "broker.mint-parent-reserved": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 6));
    const forged = { ...mintReq("c", 4, "p"), parentReserved: { w: 2 } };
    await mustRefuse(b.mint(forged), "a mint beyond the parent's fold reservation (R25) passed");
  },
  "broker.renew-stale-epoch": async (s) => {
    const b = mk(s, () => ({}));
    await b.mint(mintReq("t", 2));
    must((await b.renew(req("t", 0, 0))).granted, "setup: first renewal denied");
    must(!(await b.renew(req("t", 0, 1))).granted, "a renewal at a stale epoch was granted");
  },
  "broker.renew-born-expired": async (s) => {
    const c = clock();
    const b = mk(s, () => ({}), c);
    await b.mint({ ...mintReq("p", 4), ttlMs: 1_000 });
    await b.mint({ ...mintReq("c", 2, "p"), ttlMs: 1_000 });
    c.t += 5_000;
    must(!(await b.renew(req("c", 0, 0))).granted, "renewed under an expired parent (R12)");
  },
  "broker.reservation-never-released": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 4));
    await b.mint(mintReq("c1", 4, "p"));
    await b.revoke("c1", "kit");
    await mustRefuse(b.mint(mintReq("c2", 1, "p")), "a revoked child's reservation was released");
  },
  "carve.child-renew-ceiling": async (s) => {
    const b = mk(s, () => ({ leases: { w: 3 } }));
    await b.mint(mintReq("p", 6));
    await b.mint(mintReq("c", 2, "p"));
    must(!(await b.renew(req("c", 0, 0))).granted, "a child renewed above its minted ceiling");
  },
  "laundering.uncovered.a2a": async () => "skipped:A2A transport not available in-process",
  "laundering.covered": async () => "skipped:slice 2 (ADR 0150 D7)",
};

/**
 * Run every check against `subject`. Never throws: a failing check is reported with its message.
 *
 * Not every check can fail a broker: `carve.forged-meters` and `laundering.uncovered.shared-memory` exercise
 * the package and kernel guards (the reserved `lease.` meter prefix; the grant authorizer and lease middleware),
 * so a broken broker cannot fail them, and that is expected. They guard the stack the broker sits in.
 */
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
