import { policy$ } from "@loom/core";
import { describe, expect, it } from "vitest";
import type { CapabilityAuthorizer, CapabilityRequest } from "./authz";
import { PolicyAuthorizer } from "./policy";

const req = (over: Partial<CapabilityRequest> = {}): CapabilityRequest => ({
  toolId: "metrics",
  executionId: "e1",
  workflowId: "flow-a",
  stepId: "s1",
  ...over,
});

describe("PolicyAuthorizer", () => {
  it("allows any effect when no policy governs the principal", () => {
    const authz = new PolicyAuthorizer({});
    expect(authz.authorize(req())).toEqual({ allowed: true });
  });

  it("deny list denies the matching effect (deny-wins), allows others", () => {
    const p = policy$({ id: "p", name: "P", rules: { deny: ["external-http"] } });
    const authz = new PolicyAuthorizer({ "flow-a": [p] });
    expect(authz.authorize(req({ toolId: "external-http" })).allowed).toBe(false);
    expect(authz.authorize(req({ toolId: "metrics" })).allowed).toBe(true);
  });

  it("allow list restricts to listed effects (glob supported)", () => {
    const p = policy$({ id: "p", name: "P", rules: { allow: ["metrics", "logs-*"] } });
    const authz = new PolicyAuthorizer({ "flow-a": [p] });
    expect(authz.authorize(req({ toolId: "metrics" })).allowed).toBe(true);
    expect(authz.authorize(req({ toolId: "logs-write" })).allowed).toBe(true);
    expect(authz.authorize(req({ toolId: "external-http" })).allowed).toBe(false);
  });

  it("deny wins over allow for the same effect", () => {
    const p = policy$({ id: "p", name: "P", rules: { allow: ["*"], deny: ["secret-*"] } });
    const authz = new PolicyAuthorizer({ "flow-a": [p] });
    expect(authz.authorize(req({ toolId: "anything" })).allowed).toBe(true);
    expect(authz.authorize(req({ toolId: "secret-read" })).allowed).toBe(false);
  });

  it("rich match rules gate on effect + tenant + step globs", () => {
    const p = policy$({
      id: "p",
      name: "P",
      rules: { match: [{ effect: "external-*", tenant: "acme", deny: true }] },
    });
    const authz = new PolicyAuthorizer({ "flow-a": [p] });
    // denied only when BOTH tenant and effect match
    expect(
      authz.authorize(req({ toolId: "external-http", principal: { tenant: "acme" } })).allowed
    ).toBe(false);
    // other tenant → the deny rule doesn't fire
    expect(
      authz.authorize(req({ toolId: "external-http", principal: { tenant: "other" } })).allowed
    ).toBe(true);
  });

  it("an allow match rule creates an allow-constraint (unmatched effects denied)", () => {
    const p = policy$({
      id: "p",
      name: "P",
      rules: { match: [{ step: "read-*" }] }, // allow only read-* steps
    });
    const authz = new PolicyAuthorizer({ "flow-a": [p] });
    expect(authz.authorize(req({ stepId: "read-users" })).allowed).toBe(true);
    expect(authz.authorize(req({ stepId: "write-users" })).allowed).toBe(false);
  });

  it("global policies apply to every principal", () => {
    const g = policy$({ id: "g", name: "G", rules: { deny: ["dangerous"] } });
    const authz = new PolicyAuthorizer({}, { global: [g] });
    expect(authz.authorize(req({ workflowId: "any-flow", toolId: "dangerous" })).allowed).toBe(
      false
    );
  });

  it("composes UNDER a base authorizer — base denial is final (defense in depth)", () => {
    const base: CapabilityAuthorizer = {
      authorize: (r) =>
        r.toolId === "granted" ? { allowed: true } : { allowed: false, reason: "not granted" },
    };
    // Policy would allow everything, but the base restricts to "granted".
    const p = policy$({ id: "p", name: "P", rules: { allow: ["*"] } });
    const authz = new PolicyAuthorizer({ "flow-a": [p] }, { base });
    expect(authz.authorize(req({ toolId: "granted" })).allowed).toBe(true);
    expect(authz.authorize(req({ toolId: "other" }))).toEqual({
      allowed: false,
      reason: "not granted",
    });
  });

  it("policy can tighten a base grant but never widen it", () => {
    const base: CapabilityAuthorizer = { authorize: () => ({ allowed: true }) };
    const p = policy$({ id: "p", name: "P", rules: { deny: ["external-*"] } });
    const authz = new PolicyAuthorizer({ "flow-a": [p] }, { base });
    expect(authz.authorize(req({ toolId: "external-http" })).allowed).toBe(false); // tightened
    expect(authz.authorize(req({ toolId: "metrics" })).allowed).toBe(true);
  });
});
