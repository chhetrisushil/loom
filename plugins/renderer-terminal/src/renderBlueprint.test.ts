import {
  type Blueprint,
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

describe("renderBlueprintToString — binding status matrix and source (IR 2.0.0)", () => {
  const w = (id: string, path = `v.${id}`) =>
    MetricCard({
      id,
      title: id.toUpperCase(),
      binding: { projectionId: "p", path, status: { path: `s.${id}` } },
      unit: "ms",
    });
  // Deviation from the brief's literal `id: "b", title: "B"`: the blueprint's own title
  // collided with widget b's title "B" — `line()`'s `.find` then matched the header line
  // ("  B") before reaching "✗ B: tool down", since the header renders first. "Matrix" carries
  // no uppercase A–H substring, so it cannot shadow any of the eight cell assertions below.
  const bp = blueprint$({
    id: "b",
    title: "Matrix",
    layout: stack({ children: [w("a"), w("b"), w("c"), w("d"), w("e"), w("f"), w("g"), w("h")] }),
    projections: ["p"],
  });
  const state = {
    v: { a: 412, c: 7, e: 1, g: 2 },
    s: {
      a: { state: "error", finding: { code: "x", message: "tool down" } },
      b: { state: "error", finding: { code: "x", message: "tool down" } },
      c: { state: "stale" },
      d: { state: "stale", finding: { code: "d", message: "drifted" } },
      e: { state: "pending" },
      f: { state: "pending" },
      g: { state: "ready" },
      h: { state: "ready" },
    },
  };
  const out = renderBlueprintToString(bp, new Map([["p", state]]), {
    registry: defaultTerminalRegistry,
  }).split("\n");
  const line = (t: string) => out.find((l) => l.includes(t)) ?? "";
  it("renders the eight cells", () => {
    expect(line("A")).toBe("✗ A: tool down");
    expect(line("B")).toBe("✗ B: tool down");
    expect(line("C")).toBe("~ C: 7 ms");
    expect(line("D")).toBe("~ D: — (drifted)");
    expect(line("E")).toBe("⋯ E: 1 ms");
    expect(line("F")).toBe("⋯ F");
    expect(line("G")).toBe("G: 2 ms");
    expect(line("H")).toBe("H: —"); // ready/no value: loading on the terminal is the plain em-dash, unchanged from 1.0.0
  });
  it("a widget without a declared status channel renders exactly as before, even if the state carries a status", () => {
    const plain = blueprint$({
      id: "p",
      title: "P",
      layout: stack({
        children: [
          MetricCard({ id: "z", title: "Z", binding: { projectionId: "p", path: "v.z" } }),
        ],
      }),
      projections: ["p"],
    });
    const o = renderBlueprintToString(
      plain,
      new Map([["p", { v: { z: 9 }, s: { z: { state: "error" } } }]]),
      { registry: defaultTerminalRegistry }
    );
    expect(o).toContain("Z: 9");
    expect(o).not.toContain("✗");
  });
  it("appends the degradation chain to a degraded widget's first line, and a legacy bare-children grid renders", () => {
    const degraded = {
      ...MetricCard({ id: "t", title: "T", binding: { projectionId: "p", path: "v.t" } }),
      source: {
        type: "Trend",
        version: "1.0.0",
        degradedFrom: [{ type: "Collection", version: "1.0.0" }],
      },
    };
    const legacy = {
      _tag: "Blueprint",
      id: "l",
      title: "L",
      projections: ["p"],
      layout: { type: "grid", columns: 2, children: [degraded] },
    } as unknown as Blueprint;
    const o = renderBlueprintToString(legacy, new Map([["p", { v: { t: 3 } }]]), {
      registry: defaultTerminalRegistry,
    });
    expect(o).toContain("T: 3 (degraded from Collection@1.0.0)");
  });
});
