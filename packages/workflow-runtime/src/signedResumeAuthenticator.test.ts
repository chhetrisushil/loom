import { runResumeAuthenticatorConformance } from "@loom/conformance";
import { describe, expect, it } from "vitest";
import { signResume, signedResumeAuthenticator } from "./signedResumeAuthenticator";
import type { ResumeEvent, ResumeVerificationContext } from "./types";

const keys = { alice: "alice-secret-0123456789", bob: "bob-secret-0123456789ab" };
const make = () => signedResumeAuthenticator({ gates: ["Approved", "Approval"], keys });

runResumeAuthenticatorConformance(make, "signedResumeAuthenticator");

const ctx: ResumeVerificationContext = {
  executionId: "exec-A",
  parkedAtSequence: 7,
  principal: undefined,
};
const bind = { executionId: "exec-A", parkedAtSequence: 7, exp: 2_000_000_000_000 };
const sign = (actor: "alice" | "bob" = "alice", more: Partial<typeof bind> = {}) =>
  signResume(ev(), { actor, secret: keys[actor], ...bind, ...more });

const ev = (): ResumeEvent => ({
  eventType: "Approval",
  payload: { approved: true, viewDigest: "v2:abc" },
});

describe("signedResumeAuthenticator", () => {
  it("verifies a signed event and names the actor and the mechanism", () => {
    expect(make().verify(sign(), ctx)).toEqual({
      status: "verified",
      actor: "alice",
      verifiedBy: "hmac-sha256",
    });
  });

  it("rejects an actor-less / unsigned approval (nothing to attribute it to)", () => {
    for (const payload of [
      { approved: true },
      null,
      "yes",
      { proof: {} },
      { proof: { sig: "x" } },
    ]) {
      expect(make().verify({ eventType: "Approval", payload }, ctx).status).toBe("rejected");
    }
    const blank = signResume(ev(), { actor: "   ", secret: "s".repeat(20), ...bind });
    expect(make().verify(blank, ctx).status).toBe("rejected");
  });

  it("rejects a forged signature, an unknown actor, and another actor's key", () => {
    const a = make();
    const s = (actor: string, secret: string) => signResume(ev(), { actor, secret, ...bind });
    expect(a.verify(s("alice", "not-the-key-0123456789"), ctx).status).toBe("rejected");
    expect(a.verify(s("mallory", "x".repeat(20)), ctx).status).toBe("rejected");
    expect(a.verify(s("alice", keys.bob), ctx).status).toBe("rejected");
    // __proto__ / inherited keys are not actors
    expect(a.verify(s("constructor", "x".repeat(20)), ctx).status).toBe("rejected");
  });

  it("rejects a payload altered after signing — including the echoed viewDigest", () => {
    const signed = sign();
    const tampered = {
      ...signed,
      payload: { ...(signed.payload as object), viewDigest: "v2:other" },
    };
    expect(make().verify(tampered, ctx).status).toBe("rejected");
    const flipped = { ...signed, payload: { ...(signed.payload as object), approved: false } };
    expect(make().verify(flipped, ctx).status).toBe("rejected");
  });

  it("covers discardLegacyAnswers: attaching one under a valid signature is rejected", () => {
    const withOverride = { ...sign(), discardLegacyAnswers: { stepId: "s", count: 1 } };
    expect(make().verify(withOverride, ctx).status).toBe("rejected");
    const signedWith = signResume(
      { ...ev(), discardLegacyAnswers: { stepId: "s", count: 1 } },
      { actor: "alice", secret: keys.alice, ...bind }
    );
    expect(make().verify(signedWith, ctx).status).toBe("verified");
  });

  it("an event for a gate it does not govern is not-applicable (timers, recovery)", () => {
    expect(make().verify({ eventType: "TIMER_FIRED", payload: null }, ctx).status).toBe(
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
    const live = sign("alice", { exp: 2_000 });
    expect(a.verify(live, ctx).status).toBe("verified");
    t = 2_001;
    expect(a.verify(live, ctx).status).toBe("rejected");
    t = 1_000;
    expect(a.verify(sign("bob"), ctx).status).toBe("rejected");
  });
});

describe("R13 round 1 — a signature is for ONE park of ONE execution", () => {
  it("is rejected at another execution (a fork has its own id) and at a later park", () => {
    const a = make();
    const signed = sign();
    expect(a.verify(signed, ctx).status).toBe("verified");
    const other = a.verify(signed, { ...ctx, executionId: "exec-B" });
    expect(other.status).toBe("rejected");
    const later = a.verify(signed, { ...ctx, parkedAtSequence: 12 });
    expect(later.status).toBe("rejected");
  });

  it("cannot be bound without a park: no context, or an execution that is not parked", () => {
    const a = make();
    expect(a.verify(sign()).status).toBe("rejected");
    expect(a.verify(sign(), { ...ctx, parkedAtSequence: undefined }).status).toBe("rejected");
  });

  it("requires an expiry (a proof with none is rejected, and a stripped one breaks the MAC)", () => {
    const a = make();
    const signed = sign();
    const { exp: _drop, ...noExp } = (signed.payload as { proof: Record<string, unknown> }).proof;
    const stripped = {
      ...signed,
      payload: { ...(signed.payload as object), proof: noExp },
    };
    const v = a.verify(stripped, ctx);
    expect(v.status).toBe("rejected");
    expect((v as { reason: string }).reason).toContain("expiry");
  });

  it("the signing actor must be the calling principal when the call carries one", () => {
    const a = make();
    expect(a.verify(sign(), { ...ctx, principal: { actor: "alice" } }).status).toBe("verified");
    const v = a.verify(sign(), { ...ctx, principal: { actor: "bob" } });
    expect(v.status).toBe("rejected");
    expect((v as { reason: string }).reason).toContain("not the principal");
    // a principal with no actor does not constrain (the proof is then the only identity)
    expect(a.verify(sign(), { ...ctx, principal: { tenant: "t" } }).status).toBe("verified");
  });

  it("requireActor replaces that default", () => {
    const strictAll = signedResumeAuthenticator({
      gates: ["Approval"],
      keys,
      requireActor: (actor, principal) => principal?.actor === actor,
    });
    expect(strictAll.verify(sign(), ctx).status).toBe("rejected"); // no principal at all
    expect(strictAll.verify(sign(), { ...ctx, principal: { actor: "alice" } }).status).toBe(
      "verified"
    );
  });

  it("refuses empty or short secrets: at construction for a record, at lookup for a function; signing too", () => {
    expect(() => signedResumeAuthenticator({ gates: ["A"], keys: { alice: "" } })).toThrow(
      /shorter than 16/
    );
    expect(() => signedResumeAuthenticator({ gates: ["A"], keys: { alice: "short" } })).toThrow();
    expect(() => signResume(ev(), { actor: "alice", secret: "", ...bind })).toThrow(/at least 16/);
    const lookup = signedResumeAuthenticator({ gates: ["Approval"], keys: () => "tiny" });
    expect(lookup.verify(sign(), ctx).status).toBe("rejected");
  });

  it("key rotation: keys may return several secrets; a signature by any verifies", () => {
    const old = "old-secret-0123456789ab";
    const rotating = signedResumeAuthenticator({
      gates: ["Approval"],
      keys: { alice: [keys.alice, old] },
    });
    expect(rotating.verify(sign(), ctx).status).toBe("verified");
    const oldSigned = signResume(ev(), { actor: "alice", secret: old, ...bind });
    expect(rotating.verify(oldSigned, ctx).status).toBe("verified");
    const fn = signedResumeAuthenticator({
      gates: ["Approval"],
      keys: (actor) => (actor === "alice" ? [keys.alice, old] : undefined),
    });
    expect(fn.verify(oldSigned, ctx).status).toBe("verified");
  });
});
