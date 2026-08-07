import { describe, expect, it } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import { ToolEffect } from "./effects/ToolEffect";
import { EffectModeViolationError } from "./types";
import type { EffectContext } from "./types";

// ── ADR 0072 — the determinism-boundary check ────────────────────────────────
//
// A declared `mode` pins a tool to ONE invocation seam. The point is that a
// surface which can invoke arbitrary tools (an MCP server serving a View's
// `tools/call`) can route from the declaration instead of a hardcoded list.

function ctx(overrides: Partial<EffectContext> = {}): EffectContext {
  return {
    executionId: "exec-1",
    stepId: "step-1",
    workflowId: "wf-1",
    attempt: 1,
    emit: () => {},
    ...overrides,
  };
}

describe("effect mode boundary (ADR 0072)", () => {
  it("refuses an ambient effect inside an execution", async () => {
    const rt = new EffectRuntime();
    rt.register("page", new ToolEffect(async () => ({ rows: [] }), { mode: "ambient" }));

    await expect(rt.execute("page", { page: 2 }, ctx())).rejects.toThrow(EffectModeViolationError);
    // The message names the right escape hatch — this is a wrong-entry-point bug.
    await expect(rt.execute("page", { page: 2 }, ctx())).rejects.toThrow(/invokeTransient/);
  });

  it("allows an ambient effect transiently", async () => {
    const rt = new EffectRuntime();
    rt.register("page", new ToolEffect(async () => ({ rows: [1, 2] }), { mode: "ambient" }));

    await expect(rt.invokeTransient("page", { page: 2 })).resolves.toEqual({ rows: [1, 2] });
  });

  it("refuses a journaled effect invoked transiently", async () => {
    const rt = new EffectRuntime();
    rt.register("approve", new ToolEffect(async () => "ok", { mode: "journaled" }));

    await expect(rt.invokeTransient("approve", {})).rejects.toThrow(EffectModeViolationError);
    await expect(rt.invokeTransient("approve", {})).rejects.toThrow(/ctx\.execute/);
  });

  it("allows a journaled effect inside an execution", async () => {
    const rt = new EffectRuntime();
    rt.register("approve", new ToolEffect(async () => "ok", { mode: "journaled" }));

    await expect(rt.execute("approve", {}, ctx())).resolves.toBe("ok");
  });

  it("carries the violation's declared/attempted seams for a router to branch on", async () => {
    const rt = new EffectRuntime();
    rt.register("page", new ToolEffect(async () => null, { mode: "ambient" }));

    const err = await rt.execute("page", {}, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectModeViolationError);
    expect((err as EffectModeViolationError).toolId).toBe("page");
    expect((err as EffectModeViolationError).declared).toBe("ambient");
    expect((err as EffectModeViolationError).attempted).toBe("journaled");
  });

  // G2 — the marker is a true no-op until an author opts in. Everything already
  // registered keeps working on BOTH seams, byte-identically.
  it("leaves undeclared effects usable on both seams", async () => {
    const rt = new EffectRuntime();
    rt.register("legacy", new ToolEffect(async () => "v"));

    await expect(rt.execute("legacy", {}, ctx())).resolves.toBe("v");
    await expect(rt.invokeTransient("legacy", {})).resolves.toBe("v");
  });

  it("cannot be spoofed by a hand-built transient-looking context", async () => {
    const rt = new EffectRuntime();
    rt.register("page", new ToolEffect(async () => null, { mode: "ambient" }));

    // A context that merely *looks* like invokeTransient's synthetic one still
    // came through `execute`, so the boundary holds: the seam is a property of
    // the entry point, never of the context's contents.
    await expect(
      rt.execute(
        "page",
        {},
        ctx({ executionId: "transient:page", workflowId: "transient", stepId: "page" })
      )
    ).rejects.toThrow(EffectModeViolationError);
  });
});
