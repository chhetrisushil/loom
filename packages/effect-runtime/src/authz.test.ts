import { describe, expect, it, vi } from "vitest";
import { CapabilityDeniedError, GrantTable } from "./authz";
import { EffectRuntime } from "./EffectRuntime";
import { ToolEffect } from "./effects/ToolEffect";
import type { EffectContext } from "./types";

function ctx(overrides: Partial<EffectContext> = {}): EffectContext {
  return {
    executionId: "e1",
    workflowId: "wf",
    stepId: "s1",
    attempt: 1,
    emit: vi.fn(),
    ...overrides,
  };
}

const req = (toolId: string, over: Partial<{ workflowId: string; executionId: string }> = {}) => ({
  toolId,
  workflowId: over.workflowId ?? "wf",
  executionId: over.executionId ?? "e1",
  stepId: "s1",
});

describe("GrantTable", () => {
  it("allows granted effects and denies everything else (least-privilege)", () => {
    const t = new GrantTable({ wf: ["metrics-tool", "logs-tool"] });
    expect(t.authorize(req("metrics-tool")).allowed).toBe(true);
    const denied = t.authorize(req("danger-tool"));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("not granted");
  });

  it("denies principals that have no grants at all", () => {
    const t = new GrantTable({ wf: ["x"] });
    expect(t.authorize(req("x", { workflowId: "other" })).allowed).toBe(false);
  });

  it("honours the * wildcard", () => {
    const t = new GrantTable({ wf: ["*"] });
    expect(t.authorize(req("anything")).allowed).toBe(true);
  });

  it("supports a custom principal (per-execution grants)", () => {
    const t = new GrantTable({ "exec-1": ["x"] }, { principal: (r) => r.executionId });
    expect(t.authorize(req("x", { executionId: "exec-1" })).allowed).toBe(true);
    expect(t.authorize(req("x", { executionId: "exec-2" })).allowed).toBe(false);
  });
});

describe("EffectRuntime — capability enforcement (K2)", () => {
  it("runs a granted effect normally", async () => {
    const rt = new EffectRuntime([], { authorizer: new GrantTable({ wf: ["ok"] }) });
    rt.register("ok", new ToolEffect(async () => ({ done: true })));
    await expect(rt.execute("ok", {}, ctx())).resolves.toEqual({ done: true });
  });

  it("denies an ungranted effect: emits EFFECT_DENIED then throws CapabilityDeniedError", async () => {
    const rt = new EffectRuntime([], { authorizer: new GrantTable({ wf: ["ok"] }) });
    rt.register("danger", new ToolEffect(async () => ({ done: true })));
    const emit = vi.fn();
    await expect(rt.execute("danger", {}, ctx({ emit }))).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(emit).toHaveBeenCalledWith(
      "EFFECT_DENIED",
      expect.objectContaining({ toolId: "danger", stepId: "s1" })
    );
  });

  it("denies BEFORE the effect runs (effect body never invoked)", async () => {
    const rt = new EffectRuntime([], { authorizer: new GrantTable({ wf: [] }) });
    const body = vi.fn(async () => ({}));
    rt.register("danger", new ToolEffect(body));
    await expect(rt.execute("danger", {}, ctx())).rejects.toThrow(CapabilityDeniedError);
    expect(body).not.toHaveBeenCalled();
  });

  it("with no authorizer, is permissive (unchanged behaviour)", async () => {
    const rt = new EffectRuntime();
    rt.register("anything", new ToolEffect(async () => "ok"));
    await expect(rt.execute("anything", {}, ctx())).resolves.toBe("ok");
  });
});
