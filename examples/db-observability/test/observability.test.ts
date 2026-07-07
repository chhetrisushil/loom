import type { Blueprint, Layout, Widget } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

// Collect every widget kind in a (dynamically assembled) blueprint.
function widgetKinds(blueprint: Blueprint): string[] {
  const kinds: string[] = [];
  const walk = (node: Layout | Widget): void => {
    if ("_tag" in node && node._tag === "Widget") {
      kinds.push(node.kind);
      return;
    }
    for (const child of (node as Layout).children) walk(child as Layout | Widget);
  };
  walk(blueprint.layout);
  return kinds;
}

describe("db-observability", () => {
  it("classifies a 'why CPU' question and generates a what+why dashboard", async () => {
    const { composer } = buildApp();
    const r = await composer.answer("Why is the CPU utilization high?");

    expect(r.classification.topic).toBe("cpu");
    expect(r.classification.kind).toBe("why");
    expect(r.what).toContain("91%"); // the direct answer, from live telemetry
    expect(r.whatWidget).toBe("cpu.metric"); // primary widget for the topic
    expect(r.whyWidgets).toContain("queries.slow"); // a causal supporting widget

    // The blueprint was assembled from the catalogue: the primary metric + the
    // causal widgets are present.
    const kinds = widgetKinds(r.blueprint);
    expect(kinds).toContain("MetricCard"); // cpu.metric (the WHAT)
    expect(kinds).toContain("ProgressBar"); // connections.saturation (a WHY)
    expect(kinds).toContain("DataTable"); // queries.slow (a WHY)
  });

  it("routes a different question to a different dashboard", async () => {
    const { composer } = buildApp();
    const r = await composer.answer("What is the connection saturation level?");
    expect(r.classification.topic).toBe("connections");
    expect(r.classification.kind).toBe("what");
    expect(r.whatWidget).toBe("connections.saturation");
    expect(r.blueprint.title).toContain("Connection saturation");
  });

  it("renders the WHAT answer and WHY supporting values headlessly", async () => {
    const { composer, renderer, executionId } = buildApp();
    const r = await composer.answer("Why is the CPU utilization high?");
    const out = renderer.render(r.blueprint, executionId);

    expect(out).toContain("WHAT");
    expect(out).toContain("WHY");
    expect(out).toContain("CPU utilization is 91%"); // the WHAT answer
    expect(out).toContain("Connection pool"); // a WHY widget title
    expect(out).toContain("98"); // the bound connections value
  });

  it("generates topic-specific widgets from the same catalogue", async () => {
    const { composer } = buildApp();
    const cpu = await composer.answer("Why is CPU high?");
    const repl = await composer.answer("Is replica lag rising?");

    expect(cpu.whatWidget).toBe("cpu.metric");
    expect(repl.whatWidget).toBe("replication.lag");
    expect(repl.classification.topic).toBe("replication");
    // Different intents → different dashboards from the one catalogue.
    expect(cpu.blueprint.id).not.toBe(repl.blueprint.id);
  });
});
