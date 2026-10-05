import { runResumeAuthenticatorConformance } from "@loom/conformance";
import { describe, expect, it } from "vitest";
import { signResume, signedResumeAuthenticator } from "./signedResumeAuthenticator";
import type { ResumeEvent } from "./types";

const keys = { alice: "alice-secret", bob: "bob-secret" };
const make = () => signedResumeAuthenticator({ gates: ["Approved", "Approval"], keys });

runResumeAuthenticatorConformance(make, "signedResumeAuthenticator");

const ev = (): ResumeEvent => ({
  eventType: "Approval",
  payload: { approved: true, viewDigest: "v1:abc" },
});

describe("signedResumeAuthenticator", () => {
  it("verifies a signed event and names the actor and the mechanism", () => {
    const v = make().verify(signResume(ev(), { actor: "alice", secret: keys.alice }));
    expect(v).toEqual({ status: "verified", actor: "alice", verifiedBy: "hmac-sha256" });
  });

  it("rejects an actor-less / unsigned approval (nothing to attribute it to)", () => {
    for (const payload of [
      { approved: true },
      null,
      "yes",
      { proof: {} },
      { proof: { sig: "x" } },
    ]) {
      const v = make().verify({ eventType: "Approval", payload });
      expect(v.status).toBe("rejected");
    }
    const blank = signResume(ev(), { actor: "   ", secret: "s" });
    expect(make().verify(blank).status).toBe("rejected");
  });

  it("rejects a forged signature, an unknown actor, and another actor's key", () => {
    const a = make();
    const forged = signResume(ev(), { actor: "alice", secret: "not-the-key" });
    expect(a.verify(forged).status).toBe("rejected");
    expect(a.verify(signResume(ev(), { actor: "mallory", secret: "x" })).status).toBe("rejected");
    expect(a.verify(signResume(ev(), { actor: "alice", secret: keys.bob })).status).toBe(
      "rejected"
    );
    // __proto__ / inherited keys are not actors
    expect(a.verify(signResume(ev(), { actor: "constructor", secret: "x" })).status).toBe(
      "rejected"
    );
  });

  it("rejects a payload altered after signing — including the echoed viewDigest", () => {
    const signed = signResume(ev(), { actor: "alice", secret: keys.alice });
    const tampered = {
      ...signed,
      payload: { ...(signed.payload as object), viewDigest: "v1:other" },
    };
    expect(make().verify(tampered).status).toBe("rejected");
    const flipped = { ...signed, payload: { ...(signed.payload as object), approved: false } };
    expect(make().verify(flipped).status).toBe("rejected");
  });

  it("covers discardLegacyAnswers: attaching one under a valid signature is rejected", () => {
    const signed = signResume(ev(), { actor: "alice", secret: keys.alice });
    const withOverride = { ...signed, discardLegacyAnswers: { stepId: "s", count: 1 } };
    expect(make().verify(withOverride).status).toBe("rejected");
    const signedWith = signResume(
      { ...ev(), discardLegacyAnswers: { stepId: "s", count: 1 } },
      { actor: "alice", secret: keys.alice }
    );
    expect(make().verify(signedWith).status).toBe("verified");
  });

  it("an event for a gate it does not govern is not-applicable (timers, recovery)", () => {
    expect(make().verify({ eventType: "TIMER_FIRED", payload: null }).status).toBe(
      "not-applicable"
    );
  });

  it("honours expiry and the optional role check", () => {
    let t = 1_000;
    const a = signedResumeAuthenticator({
      gates: ["Approval"],
      keys,
      now: () => t,
      authorize: (actor) => actor === "alice",
    });
    const live = signResume(ev(), { actor: "alice", secret: keys.alice, exp: 2_000 });
    expect(a.verify(live).status).toBe("verified");
    t = 2_001;
    expect(a.verify(live).status).toBe("rejected");
    t = 1_000;
    const bob = signResume(ev(), { actor: "bob", secret: keys.bob });
    const v = a.verify(bob);
    expect(v.status).toBe("rejected");
  });
});
