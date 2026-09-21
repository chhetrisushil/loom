import {
  MetricCard,
  RendererRegistry,
  StatusBadge,
  Timeline,
  blueprint$,
  customWidget$,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { type TerminalWidgetRenderer, defaultTerminalRegistry } from "./defaultRegistry";
import { TerminalRenderer, renderBlueprintToString } from "./renderBlueprint";

const bp = blueprint$({
  id: "dash",
  title: "Ops Dashboard",
  layout: stack({
    children: [
      StatusBadge({ title: "Phase", binding: { projectionId: "ui", path: "phase" } }),
      grid({
        columns: 2,
        children: [
          MetricCard({
            title: "CPU %",
            binding: { projectionId: "metrics", path: "cpu" },
            unit: "%",
          }),
          MetricCard({ title: "Memory", binding: { projectionId: "metrics", path: "mem" } }),
        ],
      }),
      Timeline({ title: "Events", binding: { projectionId: "log", path: "items" } }),
    ],
  }),
  projections: ["ui", "metrics", "log"],
});

describe("renderBlueprintToString", () => {
  it("renders widget titles and resolved values as text", () => {
    const stateMap = new Map<string, unknown>([
      ["ui", { phase: "triaging" }],
      ["metrics", { cpu: 87, mem: 14000 }],
      ["log", { items: ["started", "fetched metrics"] }],
    ]);
    const out = renderBlueprintToString(bp, stateMap);

    expect(out).toContain("Ops Dashboard");
    expect(out).toContain("Phase: triaging");
    expect(out).toContain("CPU %: 87");
    expect(out).toContain("Memory: 14000");
    // array value rendered as bullet list
    expect(out).toContain("• started");
    expect(out).toContain("• fetched metrics");
  });

  it("renders a placeholder for missing values", () => {
    const out = renderBlueprintToString(bp, new Map());
    expect(out).toContain("Phase: —");
    expect(out).toContain("CPU %: —");
  });
});

// ── Kind-aware path (ADR 0096) ────────────────────────────────────────────────
//
// Three states, kept distinct: no registry → the kind-blind text above, unchanged; registry with
// the kind → the renderer's block; registry WITHOUT the kind → an explicit `[kind]` marker. The
// third is the one that matters: the old renderer degraded silently, and silent is the defect.

describe("renderBlueprintToString — with a registry", () => {
  const state = new Map<string, unknown>([
    ["ui", { phase: "triaging" }],
    ["metrics", { cpu: 87, mem: 14000 }],
    ["log", { items: ["started", "fetched metrics"] }],
  ]);

  it("is byte-identical to the kind-blind output when no registry is passed", () => {
    const golden =
      "════════════════════════\n" +
      "  Ops Dashboard\n" +
      "════════════════════════\n" +
      "Phase: triaging\n" +
      "CPU %: 87\n" +
      "Memory: 14000\n" +
      "Events:\n" +
      "    • started\n" +
      "    • fetched metrics\n";
    expect(renderBlueprintToString(bp, state)).toBe(golden);
    expect(renderBlueprintToString(bp, state, {})).toBe(golden);
  });

  it("uses the registered renderer for a known kind", () => {
    const out = renderBlueprintToString(bp, state, { registry: defaultTerminalRegistry });
    expect(out).toContain("Phase: [triaging]"); // StatusBadge, kind-aware
    expect(out).toContain("CPU %: 87 %"); // MetricCard with unit
  });

  it("marks a kind the registry lacks instead of silently flattening it", () => {
    const heat = blueprint$({
      id: "h",
      title: "Heat",
      layout: stack({
        children: [
          customWidget$({
            kind: "Heatmap",
            title: "CPU heat",
            binding: { projectionId: "m", path: "h" },
          }),
        ],
      }),
      projections: ["m"],
    });
    const out = renderBlueprintToString(heat, new Map([["m", { h: [1, 2] }]]), {
      registry: defaultTerminalRegistry,
    });
    expect(out).toContain("[Heatmap] CPU heat:");
    // and the same blueprint with NO registry carries no marker — the states are distinct
    expect(renderBlueprintToString(heat, new Map([["m", { h: [1, 2] }]]))).not.toContain(
      "[Heatmap]"
    );
  });

  it("TerminalRenderer forwards its options", () => {
    const projectionRuntime = {
      getState: (projectionId: string) => state.get(projectionId),
    } as unknown as ConstructorParameters<typeof TerminalRenderer>[0];
    const registry = new RendererRegistry<TerminalWidgetRenderer>().register(
      "StatusBadge",
      (w, v) => `${w.title} => ${String(v)}`
    );
    const out = new TerminalRenderer(projectionRuntime, { registry }).render(bp, "exec-1");
    expect(out).toContain("Phase => triaging");
    expect(out).toContain("[MetricCard] CPU %: 87"); // not in this registry → marked
  });
});
