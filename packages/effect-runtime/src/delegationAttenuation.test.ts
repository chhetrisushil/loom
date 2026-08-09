import { describe, expect, it } from "vitest";
import {
  type DelegatedGrant,
  DelegationAuthorizer,
  attenuateDelegation,
  signDelegation,
  verifyDelegation,
} from "./authz";

const SECRET = "shared-delegation-secret";
const req = (toolId: string, actor: string, delegation: DelegatedGrant) => ({
  toolId,
  executionId: "e",
  workflowId: "w",
  stepId: "s",
  principal: { actor, delegation },
});

describe("attenuateDelegation — narrowing is enforced on BOTH axes", () => {
  it("inherits the parent's expiry — a child must not outlive its parent", () => {
    const expiresAt = 10_000;
    const parent = signDelegation(SECRET, "alice", ["read", "write"], expiresAt);
    const child = attenuateDelegation(SECRET, parent, "bob", ["read"]);
    expect(child.exp).toBe(expiresAt);

    // The regression: `exp` was dropped, so the child never expired. Narrowing the grant
    // set while making the token immortal is broadening, not attenuating.
    const past = new DelegationAuthorizer({ secret: SECRET, now: () => expiresAt + 1 });
    expect(past.authorize(req("read", "alice", parent)).allowed).toBe(false);
    expect(past.authorize(req("read", "bob", child)).allowed).toBe(false);

    // Still valid before the parent's expiry.
    const before = new DelegationAuthorizer({ secret: SECRET, now: () => expiresAt - 1 });
    expect(before.authorize(req("read", "bob", child)).allowed).toBe(true);
  });

  it("lets an explicit exp tighten, never extend", () => {
    const parent = signDelegation(SECRET, "alice", ["read"], 10_000);
    expect(attenuateDelegation(SECRET, parent, "bob", ["read"], 5_000).exp).toBe(5_000);
    // A later exp cannot extend the parent's.
    expect(attenuateDelegation(SECRET, parent, "bob", ["read"], 99_000).exp).toBe(10_000);
    // A parent without expiry may gain one (that is narrowing).
    const forever = signDelegation(SECRET, "alice", ["read"]);
    expect(attenuateDelegation(SECRET, forever, "bob", ["read"], 7_000).exp).toBe(7_000);
  });

  it("lets a wildcard parent attenuate to a concrete subset", () => {
    const parent = signDelegation(SECRET, "alice", ["*"]);
    const child = attenuateDelegation(SECRET, parent, "bob", ["read"]);
    // Filtering against the literal ["*"] array used to yield an EMPTY grant set, so a
    // wildcard delegator could not attenuate at all and would keep passing "*" onward.
    expect(child.grants).toEqual(["read"]);
    const auth = new DelegationAuthorizer({ secret: SECRET });
    expect(auth.authorize(req("read", "bob", child)).allowed).toBe(true);
    expect(auth.authorize(req("write", "bob", child)).allowed).toBe(false);
  });

  it("still refuses to widen a concrete parent", () => {
    const parent = signDelegation(SECRET, "alice", ["read"]);
    expect(attenuateDelegation(SECRET, parent, "bob", ["read", "admin"]).grants).toEqual(["read"]);
    expect(attenuateDelegation(SECRET, parent, "bob", ["*"]).grants).toEqual([]);
  });

  it("refuses to sign a child from an unverified parent", () => {
    const forged: DelegatedGrant = { grants: ["admin"], issuedTo: "mallory", sig: "00".repeat(32) };
    expect(verifyDelegation(SECRET, forged)).toBe(false);
    // Previously this laundered forged grants into a VALIDLY signed token, because the
    // function held the secret and never checked its input.
    expect(() => attenuateDelegation(SECRET, forged, "mallory", ["admin"])).toThrow(
      /failed verification/
    );
  });

  it("keeps the holder binding — a child is usable only by its issuedTo", () => {
    const parent = signDelegation(SECRET, "alice", ["read"]);
    const child = attenuateDelegation(SECRET, parent, "bob", ["read"]);
    const auth = new DelegationAuthorizer({ secret: SECRET });
    expect(auth.authorize(req("read", "bob", child)).allowed).toBe(true);
    expect(auth.authorize(req("read", "mallory", child)).allowed).toBe(false);
  });
});
