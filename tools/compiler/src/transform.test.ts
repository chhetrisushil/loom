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
