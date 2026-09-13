import { describe, expect, it } from "vitest";
import {
  DelegationAuthorizer,
  GrantTable,
  attenuateDelegation,
  signDelegation,
  verifyDelegation,
} from "./authz";
import type { CapabilityRequest, DelegationAuthorizerOptions } from "./authz";

const SECRET = "shared-delegation-secret";

function req(toolId: string, principal: CapabilityRequest["principal"]): CapabilityRequest {
  return {
    toolId,
    executionId: "e",
    workflowId: "callee-flow",
    stepId: "s",
    ...(principal && { principal }),
  };
}

describe("K12.4 — verifiable attenuated delegation", () => {
  it("signs and verifies a delegation; tampering breaks the signature", () => {
    const token = signDelegation(SECRET, "callee-flow", ["deploy", "rollback"]);
    expect(verifyDelegation(SECRET, token)).toBe(true);
    // A forged broaden: add a grant the delegator never signed.
    const forged = { ...token, grants: [...token.grants, "delete-prod"] };
    expect(verifyDelegation(SECRET, forged)).toBe(false);
    // Wrong secret (a different trust boundary) fails.
    expect(verifyDelegation("other-secret", token)).toBe(false);
  });

  it("attenuation can only NARROW, never broaden", () => {
    const token = signDelegation(SECRET, "a", ["deploy", "rollback"]);
    const narrowed = attenuateDelegation(SECRET, token, "b", ["rollback", "delete-prod"]);
    expect(narrowed.grants).toEqual(["rollback"]); // "delete-prod" was never in the parent
    expect(verifyDelegation(SECRET, narrowed)).toBe(true);
  });

  it("authorizes only the intersection of the verified delegation and the callee's own grants", () => {
    // The callee itself holds deploy + rollback.
    const base = new GrantTable({ "callee-flow": ["deploy", "rollback"] });
    const authz = new DelegationAuthorizer({ secret: SECRET, base });

    // Delegator confers deploy + delete-prod. Intersection with the callee's own
    // authority = deploy only.
    const token = signDelegation(SECRET, "callee-flow", ["deploy", "delete-prod"]);
    // The token was minted FOR "callee-flow", so the callee presents it as itself.
    const principal = { actor: "callee-flow", delegation: token };

    expect(authz.authorize(req("deploy", principal)).allowed).toBe(true);
    // delete-prod: delegated but the CALLEE lacks it → no ambient escalation.
    const denied = authz.authorize(req("delete-prod", principal));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/callee itself lacks/);
    // rollback: the callee has it but it was NOT delegated → denied.
    expect(authz.authorize(req("rollback", principal)).allowed).toBe(false);
  });

  it("denies a valid token presented by a principal other than its issuedTo (confused deputy)", () => {
    const base = new GrantTable({ "callee-flow": ["deploy"], attacker: ["deploy"] });
    const authz = new DelegationAuthorizer({ secret: SECRET, base });
    // Token minted FOR "callee-flow" — a leaked/misrouted copy presented by "attacker".
    const token = signDelegation(SECRET, "callee-flow", ["deploy"]);
    const decision = authz.authorize(req("deploy", { actor: "attacker", delegation: token }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/issued to .* but presented by/);
  });

  it("rejects an expired token and honors a live one (exp is signature-bound)", () => {
    const base = new GrantTable({ "callee-flow": ["deploy"] });
    const clock = { t: 1_000 };
    const authz = new DelegationAuthorizer({ secret: SECRET, base, now: () => clock.t });
    const token = signDelegation(SECRET, "callee-flow", ["deploy"], 2_000); // exp = 2000
    const principal = { actor: "callee-flow", delegation: token };

    expect(authz.authorize(req("deploy", principal)).allowed).toBe(true); // t=1000 < 2000
    clock.t = 2_500;
    const denied = authz.authorize(req("deploy", principal));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/expired/);
    // Tampering exp to extend it breaks the signature.
    const tampered = { ...token, exp: 9_999 };
    expect(
      authz.authorize(req("deploy", { actor: "callee-flow", delegation: tampered })).allowed
    ).toBe(false);
  });

  it("a forged delegation is denied outright (not honored as a plain field)", () => {
    const authz = new DelegationAuthorizer({
      secret: SECRET,
      base: new GrantTable({ "callee-flow": ["delete-prod"] }),
    });
    const forged = { grants: ["delete-prod"], issuedTo: "callee-flow", sig: "deadbeef" };
    const decision = authz.authorize(req("delete-prod", { delegation: forged }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/signature invalid/);
  });

  it("falls through to the base authorizer when no delegation is present", () => {
    const base = new GrantTable({ "callee-flow": ["deploy"] });
    const authz = new DelegationAuthorizer({ secret: SECRET, base });
    expect(authz.authorize(req("deploy", undefined)).allowed).toBe(true);
    expect(authz.authorize(req("rollback", undefined)).allowed).toBe(false);
  });

  // ── The symmetric-secret precondition (ADR 0024) ──────────────────────────
  //
  // `base` used to be optional, documented as "the callee delegates all of its
  // authority decisions upstream". It cannot: the secret is symmetric, so the
  // verifier is also a valid minter. These two tests pin the reasoning so the
  // option is not quietly relaxed back into a convenience.

  it("refuses to construct without `base` — the type is not the enforcement", () => {
    expect(
      // A JS caller or an `as any` bypasses the required-ness of the field entirely,
      // and an absent `base` reads as a working gate while bounding nothing.
      () => new DelegationAuthorizer({ secret: SECRET } as unknown as DelegationAuthorizerOptions)
    ).toThrow(/`base` is required/);
  });

  it("a self-minted token cannot exceed the callee's own authority", () => {
    // The threat `base` actually defends against. The callee holds the verification
    // secret, so it can mint itself a valid wildcard token — this is NOT forgery, the
    // signature is genuine and no signature check can reject it.
    const selfMinted = signDelegation(SECRET, "callee-flow", ["*"]);
    expect(verifyDelegation(SECRET, selfMinted)).toBe(true);

    const authz = new DelegationAuthorizer({
      secret: SECRET,
      base: new GrantTable({ "callee-flow": ["deploy"] }),
    });

    // Minting bought it nothing: the intersection with `base` still bounds it.
    expect(
      authz.authorize(req("deploy", { actor: "callee-flow", delegation: selfMinted })).allowed
    ).toBe(true);
    const escalated = authz.authorize(
      req("delete-prod", { actor: "callee-flow", delegation: selfMinted })
    );
    expect(escalated.allowed).toBe(false);
    expect(escalated.reason).toMatch(/the callee itself lacks/);
  });
});
