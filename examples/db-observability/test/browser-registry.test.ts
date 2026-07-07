import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/browser/registry";
import { WIDGET_CATALOGUE } from "../src/catalogue";
import { buildCore } from "../src/wiring";

describe("db-observability browser wiring", () => {
  it("registers a visual renderer for every widget kind the dashboard can emit", () => {
    const registry = buildRegistry();
    // Every kind the catalogue can produce…
    for (const entry of WIDGET_CATALOGUE) {
      expect(registry.has(entry.build().kind)).toBe(true);
    }
    // …plus the StatusBadge headers the composer adds for the WHAT/WHY sections.
    expect(registry.has("StatusBadge")).toBe(true);
    // Built-ins still available after the merge (e.g. StreamingText).
    expect(registry.has("StreamingText")).toBe(true);
  });

  it("composes a blueprint from the shared (terminal-free) core", async () => {
    const { composer } = buildCore();
    const result = await composer.answer("Why is the CPU utilization high?");
    expect(result.whatWidget).toBe("cpu.metric");
    expect(result.blueprint.projections).toContain("cpu");
  });
});
