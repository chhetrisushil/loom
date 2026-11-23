import type {
  Check,
  ConformanceReport,
  ConformanceResult,
  ConformanceSubject,
} from "./conformanceKit";
import { clock, mintReq, mk, must, mustRefuse, req } from "./conformanceKit";
import { MORE_CHECKS } from "./conformanceMore";
import { RUNTIME_CHECKS, launderingCovered } from "./conformanceRuntime";
import { type TaskGrant, taskGrantDigest, verifyTaskGrant } from "./grant";

export type {
  A2ATransport,
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
  "broker.unstarted-return",
  "broker.revoked-covers-past-digests",
  "broker.mint-subset-headroom",
  "broker.mint-parent-reserved",
  "broker.renew-stale-epoch",
  "broker.renew-born-expired",
  "broker.reservation-never-released",
  "broker.refund-foldless",
  "broker.refund-guards",
  "broker.identity-fixed",
  "broker.reads-sandbox",
  "broker.signs-current-key",
  "carve.child-renew-ceiling",
  "carve.total-spend",
  "carve.forged-meters",
  "reads.read-scope",
  "sandbox.isolated",
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
    await b.claim("p", "exec-p"); // a HELD parent has a fold: the slice-1 take-return rule
    await b.mint(mintReq("c", 4, "p"));
    await b.settleChild("c", { w: 1 });
    must(!Object.keys(await b.takeReturn("c", "other")).length, "a wrong parent took a return");
    const first = await b.takeReturn("c", "p");
    must(first.w === 3, `first takeReturn gave ${JSON.stringify(first)}, expected {"w":3}`);
    const second = await b.takeReturn("c", "p");
    must(!Object.keys(second).length, `takeReturn paid twice: ${JSON.stringify(second)}`);
  },
  "broker.unstarted-return": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 8));
    await b.claim("p", "exec-p"); // a HELD parent has a fold (an unheld one is refunded: broker.refund-foldless)
    const none = (o: Record<string, number>) => !Object.keys(o).length;
    await b.reserve("p", "u", { w: 3 });
    await b.reserve("p", "u", { w: 3 }); // idempotent
    await mustRefuse(b.reserve("p", "u", { w: 2 }), "a different reservation for a known child");
    await b.settleUnstarted("u", "other"); // not its parent: nothing
    must(none(await b.takeReturn("u", "p")), "a take before settleUnstarted paid");
    await b.settleUnstarted("u", "p");
    must(none(await b.takeReturn("u", "other")), "a wrong parent took an unstarted reservation");
    const whole = await b.takeReturn("u", "p");
    must(whole.w === 3, `the unstarted take gave ${JSON.stringify(whole)}, expected {"w":3}`);
    must(none(await b.takeReturn("u", "p")), "an unstarted reservation was taken twice");
    await mustRefuse(b.mint(mintReq("u", 3, "p")), "a child was minted after it settled unstarted");
    // EITHER started OR unstarted, never both
    await b.reserve("p", "s", { w: 4 });
    await b.mint(mintReq("s", 4, "p"));
    await b.settleChild("s", { w: 1 });
    await b.settleUnstarted("s", "p");
    must(
      (await b.takeReturn("s", "p")).w === 3,
      "settleUnstarted after settleChild changed the take"
    );
    must(
      none(await b.takeReturn("s", "p")),
      "a started child's reservation paid again via unstarted"
    );
    await b.reserve("p", "r", { w: 1 });
    await b.mint(mintReq("r", 1, "p"));
    must(await b.claim("r", "e"), "setup: the child could not start");
    await b.settleUnstarted("r", "p");
    must(
      none(await b.takeReturn("r", "p")),
      "a CLAIMED (started) child returned its whole reservation"
    );
    // I2: a child minted but never claimed can no longer start, and takes its whole lease back once
    const b2 = mk(s);
    await b2.mint(mintReq("p", 6));
    await b2.claim("p", "exec-p"); // a held parent (the slice-1 rules)
    await b2.reserve("p", "m", { w: 6 });
    await b2.mint({ ...mintReq("m", 6, "p"), parentReserved: { w: 6 } });
    await b2.settleUnstarted("m", "p");
    must(!(await b2.claim("m", "e")), "a minted, never-started child could still be claimed");
    must((await b2.current("m")) === undefined, "settleUnstarted left the child's grant live");
    must(
      (await b2.takeReturn("m", "p")).w === 6,
      "the unstarted minted child's take was not whole"
    );
    must(none(await b2.takeReturn("m", "p")), "the unstarted minted child was paid twice");
    // I1 (R36): returning a reservation must not let an UNRESERVED child be carved on top of it
    await mustRefuse(
      b2.mint({ ...mintReq("v", 6, "p"), parentReserved: { w: 6 } }),
      "an unreserved child was minted after a minted child's reservation was returned"
    );
    const b3 = mk(s);
    await b3.mint(mintReq("p", 6));
    await b3.claim("p", "exec-p"); // a held parent (the slice-1 rules)
    await b3.reserve("p", "u2", { w: 6 });
    await b3.settleUnstarted("u2", "p"); // never minted
    must((await b3.takeReturn("u2", "p")).w === 6, "setup: the unminted take was not whole");
    await mustRefuse(
      b3.mint({ ...mintReq("v", 6, "p"), parentReserved: { w: 6 } }),
      "an unreserved child was minted after an unminted reservation was returned"
    );
    // settleUnstarted is atomic with claim: never BOTH started and paid the whole reservation
    const b4 = mk(s);
    await b4.mint(mintReq("p", 6));
    await b4.claim("p", "exec-p"); // a held parent (the slice-1 rules)
    await b4.reserve("p", "r2", { w: 6 });
    await b4.mint({ ...mintReq("r2", 6, "p"), parentReserved: { w: 6 } });
    const [, claimed] = await Promise.all([b4.settleUnstarted("r2", "p"), b4.claim("r2", "e")]);
    const paid = await b4.takeReturn("r2", "p");
    must(
      !(claimed && paid.w === 6),
      "a child both started (claimed) and took its whole reservation"
    );
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
  "broker.refund-foldless": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 10)); // never claimed: no fold (a schedule grant)
    await b.mint(mintReq("c1", 10, "p"));
    await b.claim("c1", "exec-c1"); // only a STARTED child is refunded (R26)
    await mustRefuse(b.mint(mintReq("c2", 1, "p")), "the parent had no headroom left");
    await b.settleChild("c1", { w: 1 }); // spent 1 of 10
    must(
      !Object.keys(await b.takeReturn("c1", "p")).length,
      "a fold-less parent's refund was also takeable (double count)"
    );
    await b.mint(mintReq("c2", 9, "p")); // the 9 unused went back to the parent's headroom
    await mustRefuse(b.mint(mintReq("c3", 1, "p")), "the refund exceeded what was unused");
    await b.settleChild("c1", { w: 1 }); // a repeat must not refund again
    await mustRefuse(b.mint(mintReq("c4", 1, "p")), "a second settleChild refunded again");
  },
  "broker.refund-guards": async (s) => {
    const b = mk(s);
    await b.mint(mintReq("p", 10)); // no fold
    await b.mint(mintReq("c1", 5, "p"));
    await b.claim("c1", "exec-c1");
    await b.mint(mintReq("c3", 5, "p")); // minted, never claimed
    await b.settleChild("c3", {}); // claims nothing was spent: must NOT refund a child that never started
    await mustRefuse(
      b.mint(mintReq("c4", 1, "p")),
      "an unclaimed child was refunded by settleChild"
    );
    await b.settleChild("c1", { w: 1 }); // started: 4 of 5 refunded
    must((await b.current("c1")) === undefined, "a settled child's grant stayed live");
    must(
      !(await b.renew(req("c1", 0, 0))).granted,
      "a settled child renewed (re-inflating its reservation)"
    );
    await mustRefuse(b.mint(mintReq("c1", 5, "p")), "a settled child id was minted again");
    await b.mint(mintReq("c4", 4, "p")); // exactly the refunded 4
    await mustRefuse(
      b.mint(mintReq("c5", 1, "p")),
      "the headroom was inflated past what was unused (renew or re-reserve)"
    );
    await b.reserve("p", "u", { w: 1 }).catch(() => undefined);
    await b.settleUnstarted("u", "p");
    must(
      !Object.keys(await b.takeReturn("u", "p")).length,
      "an unstarted reservation of a fold-less parent was takeable"
    );
  },
  "broker.identity-fixed": async (s) => {
    const b = mk(s, () => ({}));
    const id = { tenant: "kit-tenant", onBehalfOf: "kit-user" };
    await b.mint({ ...mintReq("p", 4), ...id });
    const kid = await b.mint(mintReq("c", 2, "p"));
    must(
      kid.tenant === id.tenant && kid.onBehalfOf === id.onBehalfOf,
      "a child did not inherit identity (R30)"
    );
    await mustRefuse(
      b.mint({ ...mintReq("x", 1, "p"), tenant: "other-tenant" }),
      "a child was minted into a different tenant (R30)"
    );
    await b.mint(mintReq("free", 4));
    await mustRefuse(
      b.mint({ ...mintReq("y", 1, "free"), tenant: "kit-tenant" }),
      "a child of an identity-free parent was minted into a tenant (R30)"
    );
    must((await b.renew(req("p", 0, 0))).granted, "setup: renewal denied");
    const now = await b.current("p");
    must(
      now?.tenant === id.tenant && now?.onBehalfOf === id.onBehalfOf,
      "a renewal dropped or changed tenant/onBehalfOf (R30)"
    );
  },
  "broker.reads-sandbox": async (s) => {
    // ADR 0150 S-R4: `reads` and `sandbox` are carried by a child and a renewal, and a child never widens them.
    const b = mk(s, () => ({}));
    await b.mint({ ...mintReq("p", 4), reads: ["mem:*"], sandbox: "isolated" });
    const kid = await b.mint({ ...mintReq("c", 2, "p"), reads: ["mem:a"], sandbox: "isolated" });
    must(
      kid.reads?.join() === "mem:a" && kid.sandbox === "isolated",
      "a child did not carry its reads / sandbox"
    );
    await mustRefuse(
      b.mint({ ...mintReq("x1", 1, "p"), reads: ["other:a"], sandbox: "isolated" }),
      "a child was minted with a read the parent lacks"
    );
    await mustRefuse(
      b.mint({ ...mintReq("x2", 1, "p"), reads: ["mem:a"] }),
      "a non-isolated child of an isolated parent was minted"
    );
    for (const [i, narrow] of [["mem:a"], ["mem:a*"]].entries()) {
      const nb = mk(s);
      await nb.mint({ ...mintReq("p", 4), reads: narrow as string[] });
      await mustRefuse(
        nb.mint({ ...mintReq(`w${i}`, 1, "p"), reads: ["mem:*"] }),
        `a child with reads mem:* was minted under a parent with ${narrow}`
      );
    }
    await b.mint(mintReq("free", 4));
    await mustRefuse(
      b.mint({ ...mintReq("x3", 1, "free"), reads: ["mem:a"] }),
      "a child of a parent with no reads was minted with a read"
    );
    must((await b.renew(req("p", 0, 0))).granted, "setup: renewal denied");
    const now = await b.current("p");
    must(
      now?.reads?.join() === "mem:*" && now?.sandbox === "isolated",
      "a renewal dropped or changed reads / sandbox"
    );
    must((await b.renew(req("c", 0, 0))).granted, "setup: child renewal denied");
    const kidNow = await b.current("c");
    must(
      kidNow?.reads?.join() === "mem:a" && kidNow?.sandbox === "isolated",
      "a child renewal dropped or changed reads / sandbox"
    );
  },
  "broker.signs-current-key": async (s) => {
    // R31: with a rotation ring, mint and renewal sign with `current`, never a previous key.
    const b = s.makeBroker({
      secret: { current: "kit-key-new", previous: ["kit-key-old"] },
      now: clock().now,
      policy: () => ({ leases: { w: 20 } }),
    });
    const minted = await b.mint(mintReq("k", 4));
    must(
      verifyTaskGrant("kit-key-new", minted) !== undefined,
      "a minted grant is not signed with the current key"
    );
    must((await b.renew(req("k", 0, 0))).granted, "setup: renewal denied");
    const renewed = (await b.current("k")) as TaskGrant;
    must(
      verifyTaskGrant("kit-key-new", renewed) !== undefined,
      "a renewed grant is not signed with the current key (R31)"
    );
    must(
      verifyTaskGrant("kit-key-old", renewed) === undefined,
      "a renewed grant verifies under a previous key"
    );
  },
  "carve.child-renew-ceiling": async (s) => {
    const b = mk(s, () => ({ leases: { w: 3 } }));
    await b.mint(mintReq("p", 6));
    await b.mint(mintReq("c", 2, "p"));
    must(!(await b.renew(req("c", 0, 0))).granted, "a child renewed above its minted ceiling");
  },
  "laundering.covered": (s) => launderingCovered(s),
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
