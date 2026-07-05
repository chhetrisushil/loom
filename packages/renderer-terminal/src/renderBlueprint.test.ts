import {
  MetricCard,
  StatusBadge,
  Timeline,
  blueprint$,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { renderBlueprintToString } from "./renderBlueprint";

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
