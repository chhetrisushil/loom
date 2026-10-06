import { describe, expect, it, vi } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import {
  CapabilityDeniedError,
  DelegationAuthorizer,
  GrantTable,
  delegationDigest,
  principalBlocked,
  signDelegation,
} from "./authz";
import { ToolEffect } from "./effects/ToolEffect";
import type { EffectContext } from "./types";

// ── R3k (ADR 0111 D4) — the KERNEL refuses a principal it could not restore ─────────────────

const ctx = (principal: EffectContext["principal"]): EffectContext => ({
  executionId: "e1",
  workflowId: "wf",
  stepId: "s1",
  attempt: 1,
  emit: vi.fn(),
  ...(principal !== undefined && { principal }),
});

describe("principalBlocked", () => {
  it("names a reason for each marker the kernel's resolver sets, and none for an ordinary principal", () => {
    expect(principalBlocked(undefined)).toBeUndefined();
    expect(principalBlocked({ actor: "a", tenant: "t" })).toBeUndefined();
    expect(principalBlocked({ delegationUnresolved: "d1" })).toMatch(/could not be restored/);
    expect(principalBlocked({ principalShredded: true })).toMatch(/crypto-shredded/);
    expect(principalBlocked({ principalUnresolved: "ref x" })).toMatch(/ref x/);
  });
});

describe("EffectRuntime — refuses before ANY authorizer", () => {
  it.each([
    { delegationUnresolved: "d1" },
    { principalShredded: true as const },
    { principalUnresolved: "r" },
  ])(
    "%o: EFFECT_DENIED is emitted, the effect never runs, an allow-everything authorizer is never asked",
    async (marker) => {
      const authorize = vi.fn(() => ({ allowed: true }));
      const body = vi.fn(async () => ({}));
      const rt = new EffectRuntime([], { authorizer: { authorize } });
      rt.register("t", new ToolEffect(body));
      const c = ctx({ actor: "alice", ...marker });
      await expect(rt.execute("t", {}, c)).rejects.toBeInstanceOf(CapabilityDeniedError);
      expect(authorize).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
      expect(c.emit).toHaveBeenCalledWith(
        "EFFECT_DENIED",
        expect.objectContaining({ toolId: "t" })
      );
    }
  );

  it("denies even with NO authorizer configured (the rule is the kernel's, not an authorizer's)", async () => {
    const rt = new EffectRuntime();
    rt.register("t", new ToolEffect(async () => ({})));
    await expect(rt.execute("t", {}, ctx({ delegationUnresolved: "d" }))).rejects.toBeInstanceOf(
      CapabilityDeniedError
    );
  });

  it("an ordinary principal is unaffected", async () => {
    const rt = new EffectRuntime();
    rt.register("t", new ToolEffect(async () => ({ ok: 1 })));
    await expect(rt.execute("t", {}, ctx({ actor: "alice" }))).resolves.toEqual({ ok: 1 });
  });
});

describe("DelegationAuthorizer keeps its own deny (defence in depth)", () => {
  it("an unresolved delegation does NOT fall through to base", () => {
    const a = new DelegationAuthorizer({ secret: "s", base: new GrantTable({ wf: ["*"] }) });
    const req = { toolId: "t", workflowId: "wf", executionId: "e", stepId: "s" };
    expect(a.authorize({ ...req, principal: { actor: "x" } }).allowed).toBe(true); // base
    expect(a.authorize({ ...req, principal: { actor: "x", delegationUnresolved: "d" } })).toEqual({
      allowed: false,
      reason: expect.stringContaining("could not be restored"),
    });
  });
});

describe("delegationDigest", () => {
  it("is a stable non-bearer id: 64 hex chars, never the signature, differs per token", () => {
    const a = signDelegation("s", "alice", ["t"]);
    const b = signDelegation("s", "alice", ["u"]);
    expect(delegationDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(delegationDigest(a)).not.toBe(a.sig);
    expect(delegationDigest(a)).toBe(delegationDigest({ ...a }));
    expect(delegationDigest(a)).not.toBe(delegationDigest(b));
  });
});
