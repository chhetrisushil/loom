import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest";
import { transformFile } from "./transform";
import type { PluginState } from "./types";

function emptyState(): PluginState {
  return {
    chunks: new Map(),
    steps: new Map(),
    stepsByVarName: new Map(),
    flows: new Map(),
    skills: new Map(),
    skillsByVarName: new Map(),
    projections: new Map(),
  };
}

describe("compiler — skill instruction extraction", () => {
  it("extracts instructions$ into a lazy chunk, rewrites to a dynamic import, and lists it in the manifest", () => {
    const src = [
      'import { skill$, instructions$ } from "@loom/core";',
      "export const CpuSkill = skill$({",
      '  id: "diagnose-cpu",',
      '  name: "CPU",',
      '  description: "diagnose cpu",',
      '  instructions: instructions$("Step 1: check metrics."),',
      "});",
    ].join("\n");

    const state = emptyState();
    const result = transformFile(src, "/abs/skills.ts", state);
    expect(result).not.toBeNull();

    // The instructions prop is rewritten to a lazy dynamic import.
    expect(result!.code).toContain('() => import("\0loom:chunk:diagnose-cpu_');
    expect(result!.code).not.toContain("instructions$(");

    // The body is captured as the chunk's default export.
    const chunk = [...state.chunks.values()].find((c) => c.kind === "skill");
    expect(chunk).toBeDefined();
    expect(chunk!.chunkSource).toContain('export default "Step 1: check metrics.";');

    // The skill is recorded and points at its chunk.
    const entry = state.skills.get("diagnose-cpu");
    expect(entry?.chunkVirtualId).toBe(chunk!.chunkVirtualId);

    // The manifest exposes the skill chunk path.
    const manifest = buildManifest(state, "dist");
    expect(manifest.skills["diagnose-cpu"]?.chunk).toMatch(/^dist\/chunks\/diagnose-cpu_.*\.js$/);
  });

  it("records a skill with inline (unmarked) instructions but no chunk", () => {
    const src = [
      'import { skill$ } from "@loom/core";',
      'const raw = "inline body";',
      'export const S = skill$({ id: "s1", name: "S", description: "d", instructions: { _loomInstructionsRef: true, text: raw } });',
      // Force a chunk elsewhere so transformFile reports "modified".
      'import { step$, handler$ } from "@loom/core";',
      'export const St = step$({ id: "st", inputSchema: null, outputSchema: null, handler: handler$(async () => 1) });',
    ].join("\n");
    const state = emptyState();
    transformFile(src, "/abs/inline.ts", state);
    expect(state.skills.get("s1")?.chunkVirtualId).toBeUndefined();
    const manifest = buildManifest(state, "dist");
    expect(manifest.skills.s1?.chunk).toBe("");
  });
});

describe("compiler — projection handlers extraction", () => {
  it("extracts a projection$ handlers map into a lazy chunk, records event types, rewrites to a ref", () => {
    const src = [
      'import { projection$ } from "@loom/core";',
      "export const Counter = projection$({",
      '  id: "step-counter",',
      '  name: "Counter",',
      "  initialState: { n: 0 },",
      "  handlers: {",
      "    STEP_COMPLETED: (s, _e) => ({ n: s.n + 1 }),",
      "    STEP_FAILED: (s, _e) => ({ n: s.n }),",
      "  },",
      "});",
    ].join("\n");

    const state = emptyState();
    const result = transformFile(src, "/abs/projections.ts", state);
    expect(result).not.toBeNull();

    // The handlers map is rewritten to a lazy ref carrying the event-type keys + a loader.
    expect(result!.code).toContain("_loomProjectionHandlersRef: true");
    expect(result!.code).toContain('eventTypes: ["STEP_COMPLETED","STEP_FAILED"]');
    expect(result!.code).toContain('() => import("\0loom:chunk:step-counter_');

    // The fold map is captured as the chunk's default export.
    const chunk = [...state.chunks.values()].find((c) => c.kind === "projection");
    expect(chunk).toBeDefined();
    expect(chunk!.chunkSource).toContain("export default {");
    expect(chunk!.chunkSource).toContain("STEP_COMPLETED");

    // The projection is recorded with its event types + chunk, and surfaced in the manifest.
    const entry = state.projections.get("step-counter");
    expect(entry?.eventTypes).toEqual(["STEP_COMPLETED", "STEP_FAILED"]);
    const manifest = buildManifest(state, "dist");
    expect(manifest.projections["step-counter"]?.eventTypes).toEqual([
      "STEP_COMPLETED",
      "STEP_FAILED",
    ]);
    expect(manifest.projections["step-counter"]?.chunk).toMatch(
      /^dist\/chunks\/step-counter_.*\.js$/
    );
  });

  it("leaves handlers eager (no chunk) when a key is not statically named", () => {
    const src = [
      'import { projection$ } from "@loom/core";',
      "const evt = 'DYNAMIC';",
      "export const P = projection$({",
      '  id: "dyn",',
      '  name: "Dyn",',
      "  initialState: { n: 0 },",
      "  handlers: { [evt]: (s, _e) => ({ n: s.n + 1 }) },", // computed key — not extractable
      "});",
      // Force a chunk elsewhere so transformFile reports "modified".
      'import { step$, handler$ } from "@loom/core";',
      'export const St = step$({ id: "st", handler: handler$(async () => 1) });',
    ].join("\n");
    const state = emptyState();
    const result = transformFile(src, "/abs/dyn.ts", state);
    expect(result!.code).not.toContain("_loomProjectionHandlersRef"); // stayed eager
    expect(state.projections.get("dyn")?.chunkVirtualId).toBeUndefined();
    const manifest = buildManifest(state, "dist");
    expect(manifest.projections.dyn?.chunk).toBe("");
  });
});

describe("compiler — flow detection", () => {
  const steps = [
    'import { flow$, step$, handler$ } from "@loom/core";',
    'const a = step$({ id: "a", name: "A", handler: handler$(async () => ({})) });',
    'const b = step$({ id: "b", name: "B", handler: handler$(async () => ({})) });',
  ];

  it("detects flow$ as a direct variable initializer", () => {
    const src = [
      ...steps,
      'export const f = flow$({ id: "wf", version: "1.0.0", steps: [a, b] });',
    ].join("\n");
    const state = emptyState();
    transformFile(src, "/abs/flow.ts", state);
    const manifest = buildManifest(state, "dist");
    expect(manifest.flows.wf?.steps).toEqual(["a", "b"]);
  });

  it("detects flow$ nested in the RegisteredFlow shape `{ definition: flow$(...), runner } as RegisteredFlow` (regression)", () => {
    // The idiomatic export shape — flow$ is NOT the direct variable initializer. Before the fix
    // this produced an empty `flows` map for real apps.
    const src = [
      ...steps,
      "const runner = async () => ({});",
      'export const f = { definition: flow$({ id: "wf", version: "2.0.0", steps: [a, b] }), runner } as RegisteredFlow;',
    ].join("\n");
    const state = emptyState();
    transformFile(src, "/abs/flow.ts", state);
    const manifest = buildManifest(state, "dist");
    expect(manifest.flows.wf).toBeDefined();
    expect(manifest.flows.wf?.steps).toEqual(["a", "b"]);
    expect(manifest.flows.wf?.version).toBe("2.0.0");
  });
});

describe("compiler — runner reach in the manifest (L36)", () => {
  it("keeps runnerReach for a flow whose ONLY reach is a ctx hand-off (escapes)", () => {
    // Regression: `hasReach` counted steps/unresolved/suspends but not escapes, so a flow that
    // only hands ctx to a library (`planner.compose(x, ctx)`) lost its runnerReach and verify
    // reported it as "no runner-body analysis" instead of the undeclared hand-off.
    const src = [
      'import { flow$ } from "@loom/core";',
      'import { planner } from "./planner";',
      "const runner = async (ctx, input) => planner.compose(input, ctx);",
      'export const f = { definition: flow$({ id: "wf", version: "1.0.0", steps: [] }), runner } as RegisteredFlow;',
    ].join("\n");
    const state = emptyState();
    transformFile(src, "/abs/flow.ts", state);
    const manifest = buildManifest(state, "dist");
    expect(manifest.flows.wf?.runnerReach?.escapes?.map((e) => e.callee)).toEqual([
      "planner.compose",
    ]);
  });
});

describe("compiler — builder detection robustness (inline / nested)", () => {
  it("detects inline step$(...) inside a flow's steps array (with handler extraction)", () => {
    const src = [
      'import { flow$, step$, handler$ } from "@loom/core";',
      'export const f = flow$({ id: "wf", steps: [',
      '  step$({ id: "a", name: "A", handler: handler$(async () => ({})) }),',
      '  step$({ id: "b", name: "B", handler: handler$(async () => ({})) }),',
      "] });",
    ].join("\n");
    const state = emptyState();
    const result = transformFile(src, "/abs/flow.ts", state);
    const manifest = buildManifest(state, "dist");
    expect(manifest.flows.wf?.steps).toEqual(["a", "b"]); // inline steps resolved
    // both inline handlers are extracted into lazy chunks and rewritten to dynamic imports.
    expect([...state.chunks.values()].filter((c) => c.kind === "step")).toHaveLength(2);
    expect(result!.code).not.toContain("handler$(");
  });

  it("detects skill$(...) when nested (not a direct variable initializer)", () => {
    const src = [
      'import { skill$, instructions$ } from "@loom/core";',
      'export const skills = [skill$({ id: "s1", name: "S", description: "d", instructions: instructions$("body") })];',
    ].join("\n");
    const state = emptyState();
    transformFile(src, "/abs/skills.ts", state);
    const manifest = buildManifest(state, "dist");
    expect(manifest.skills.s1?.chunk).toMatch(/chunks\/s1_.*\.js$/);
  });
});
