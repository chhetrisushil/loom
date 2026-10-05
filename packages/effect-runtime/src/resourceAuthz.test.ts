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
