import { policy$ } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import { DelegationAuthorizer, GrantTable, capabilityIds, signDelegation } from "./authz";
import type { CapabilityRequest } from "./authz";
import { ToolEffect } from "./effects/ToolEffect";
import { PolicyAuthorizer } from "./policy";
import type { EffectContext } from "./types";

// R12 — per-resource authorization: ONE effect id can front many resources.

const req = (resource?: string): CapabilityRequest => ({
  toolId: "mcp.invoke",
  ...(resource !== undefined && { resource }),
  executionId: "e",
  workflowId: "f",
  stepId: "s",
});

describe("per-resource capability ids (R12)", () => {
  it("capabilityIds: bare effect id, plus the qualified id when a resource is named", () => {
    expect(capabilityIds(req())).toEqual(["mcp.invoke"]);
    expect(capabilityIds(req("srv/a"))).toEqual(["mcp.invoke", "mcp.invoke:srv/a"]);
  });

  it("GrantTable: a qualified grant allows only that resource; the bare grant still allows all", () => {
    const one = new GrantTable({ f: ["mcp.invoke:srv/a"] });
    expect(one.authorize(req("srv/a")).allowed).toBe(true);
    expect(one.authorize(req("srv/b")).allowed).toBe(false);
    // No resource presented => a qualified grant does NOT satisfy the bare effect (fail closed).
    expect(one.authorize(req()).allowed).toBe(false);
    const all = new GrantTable({ f: ["mcp.invoke"] });
    expect(all.authorize(req("srv/a")).allowed).toBe(true);
    expect(all.authorize(req("srv/b")).allowed).toBe(true);
  });

  it("PolicyAuthorizer: allow/deny entries can name a single resource", () => {
    const allowA = policy$({ id: "p", name: "p", rules: { allow: ["mcp.invoke:srv/a"] } });
    const a = new PolicyAuthorizer({ f: [allowA] });
    expect(a.authorize(req("srv/a")).allowed).toBe(true);
    expect(a.authorize(req("srv/b")).allowed).toBe(false);
    const denyB = policy$({ id: "q", name: "q", rules: { deny: ["mcp.invoke:srv/b"] } });
    const d = new PolicyAuthorizer({ f: [denyB] });
    expect(d.authorize(req("srv/a")).allowed).toBe(true);
    expect(d.authorize(req("srv/b")).allowed).toBe(false);
    const denyAll = policy$({ id: "r", name: "r", rules: { deny: ["mcp.invoke"] } });
    expect(new PolicyAuthorizer({ f: [denyAll] }).authorize(req("srv/a")).allowed).toBe(false);
  });

  it("DelegationAuthorizer: a delegated per-resource grant narrows to that resource", () => {
    const base = new GrantTable({ f: ["mcp.invoke"] });
    const authz = new DelegationAuthorizer({ secret: "s", base });
    const principal = {
      actor: "x",
      delegation: signDelegation("s", "x", ["mcp.invoke:srv/a"]),
    };
    expect(authz.authorize({ ...req("srv/a"), principal }).allowed).toBe(true);
    expect(authz.authorize({ ...req("srv/b"), principal }).allowed).toBe(false);
  });
});

describe("EffectRuntime passes the effect's resource to the authorizer (R12)", () => {
  const ctx: EffectContext = {
    executionId: "e",
    stepId: "s",
    workflowId: "f",
    attempt: 1,
    emit: vi.fn(),
  };
  const mk = (resourceOf?: (i: { r: string }) => string | undefined) => {
    const rt = new EffectRuntime([], { authorizer: new GrantTable({ f: ["t:ok"] }) });
    rt.register(
      "t",
      new ToolEffect(async () => "ran", resourceOf !== undefined ? { resourceOf } : {})
    );
    return rt;
  };

  it("a qualified grant runs the matching resource and denies another", async () => {
    const rt = mk((i) => i.r);
    await expect(rt.execute("t", { r: "ok" }, ctx)).resolves.toBe("ran");
    await expect(rt.execute("t", { r: "nope" }, ctx)).rejects.toMatchObject({
      name: "CapabilityDeniedError",
    });
  });

  it("a resolver that throws, or an effect with none, fails closed against a qualified grant", async () => {
    await expect(
      mk(() => {
        throw new Error("boom");
      }).execute("t", { r: "ok" }, ctx)
    ).rejects.toMatchObject({ name: "CapabilityDeniedError" });
    await expect(mk().execute("t", { r: "ok" }, ctx)).rejects.toMatchObject({
      name: "CapabilityDeniedError",
    });
  });
});

describe("PolicyAuthorizer: allow globs never widen onto a chosen resource name (R12 review P2)", () => {
  const authz = (rules: Record<string, unknown>) =>
    new PolicyAuthorizer({ f: [policy$({ id: "p", name: "p", rules })] });

  it("allow list glob `*.search` does not allow mcp.invoke on srv/wipe.search", () => {
    expect(authz({ allow: ["*.search"] }).authorize(req("srv/wipe.search")).allowed).toBe(false);
    expect(authz({ allow: ["*"] }).authorize(req("srv/anything")).allowed).toBe(true);
  });

  it("match-rule allow `*-readonly` does not allow a resource named to end -readonly", () => {
    const a = authz({ match: [{ effect: "*-readonly" }] });
    expect(a.authorize(req("srv/x-readonly")).allowed).toBe(false);
  });

  it("a qualified allow pattern must name this effect exactly", () => {
    expect(authz({ allow: ["mcp.invoke:srv/search"] }).authorize(req("srv/search")).allowed).toBe(
      true
    );
    expect(authz({ allow: ["mcp.invoke:srv/search"] }).authorize(req("srv/wipe")).allowed).toBe(
      false
    );
    expect(authz({ allow: ["mcp.invoke:srv/*"] }).authorize(req("srv/wipe")).allowed).toBe(true);
    expect(authz({ allow: ["*:srv/search"] }).authorize(req("srv/search")).allowed).toBe(false);
    expect(authz({ match: [{ effect: "mcp.invoke:srv/*" }] }).authorize(req("srv/a")).allowed).toBe(
      true
    );
    expect(authz({ match: [{ effect: "x.invoke:srv/*" }] }).authorize(req("srv/a")).allowed).toBe(
      false
    );
  });

  it("bare allow still allows every resource", () => {
    expect(authz({ allow: ["mcp.invoke"] }).authorize(req("srv/a")).allowed).toBe(true);
  });

  it("deny globs match the qualified id too (stricter)", () => {
    expect(authz({ deny: ["*wipe*"] }).authorize(req("srv/wipe")).allowed).toBe(false);
    expect(
      authz({ match: [{ effect: "*wipe", deny: true }] }).authorize(req("srv/wipe")).allowed
    ).toBe(false);
  });
});

describe("denial reasons name the resource (R12 review)", () => {
  it("PolicyAuthorizer / GrantTable / DelegationAuthorizer", () => {
    const pol = new PolicyAuthorizer({
      f: [policy$({ id: "p", name: "p", rules: { deny: ["mcp.invoke:srv/a"] } })],
    });
    expect(pol.authorize(req("srv/a")).reason).toContain("srv/a");
    const pol2 = new PolicyAuthorizer({
      f: [policy$({ id: "p", name: "p", rules: { allow: ["other"] } })],
    });
    expect(pol2.authorize(req("srv/b")).reason).toContain("srv/b");
    expect(new GrantTable({ f: ["x"] }).authorize(req("srv/c")).reason).toContain("srv/c");
    const d = new DelegationAuthorizer({
      secret: "s",
      base: new GrantTable({ f: ["mcp.invoke"] }),
    });
    const principal = { actor: "x", delegation: signDelegation("s", "x", ["other"]) };
    expect(d.authorize({ ...req("srv/d"), principal }).reason).toContain("srv/d");
  });
});
