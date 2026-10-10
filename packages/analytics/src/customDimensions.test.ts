import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { analyze, costAnalytics } from "./analyze";
import { MAX_CUSTOM_DIMENSIONS, OTHER_DIMENSION } from "./customDimensions";
import { formatIntrospection, introspect, resourceGraph } from "./introspect";

let seq = 0;
function ev(eventType: string, payload: unknown = {}): EventEnvelope {
  seq += 1;
  return {
    id: `c-${seq}`,
    workflowId: "wf",
    executionId: "x",
    eventType,
    sequence: seq,
    timestamp: seq,
    payload,
  };
}
const metered = (p: unknown) => ev("RESOURCE_METERED", p);

function log(): EventEnvelope[] {
  seq = 0;
  return [
    ev("STEP_STARTED", { stepId: "a" }),
    metered({ tokens: 10, custom: { gpu_seconds: 2, pages_scanned: 5 } }),
    ev("STEP_COMPLETED", { stepId: "a" }),
    ev("STEP_STARTED", { stepId: "b" }),
    metered({ custom: { gpu_seconds: 3 } }),
    metered({ ms: 4 }),
    ev("STEP_COMPLETED", { stepId: "b" }),
  ];
}

describe("custom metering dimensions in analytics", () => {
  it("sums custom dimensions per execution (cost) and per step (resources)", () => {
    const l = log();
    expect(analyze(l).cost.custom).toEqual({ gpu_seconds: 5, pages_scanned: 5 });
    expect(costAnalytics(l).custom).toEqual({ gpu_seconds: 5, pages_scanned: 5 });
    const g = resourceGraph(l);
    expect(g.total.custom).toEqual({ gpu_seconds: 5, pages_scanned: 5 });
    expect(g.byStep.find((n) => n.stepId === "a")?.custom).toEqual({
      gpu_seconds: 2,
      pages_scanned: 5,
    });
    expect(g.byStep.find((n) => n.stepId === "b")?.custom).toEqual({ gpu_seconds: 3 });
  });

  it("leaves built-in output untouched when nothing custom was metered", () => {
    seq = 0;
    const l = [metered({ tokens: 1, costUsd: 0.5, ms: 2 })];
    const c = analyze(l).cost;
    expect(c).toStrictEqual({
      tokens: 1,
      costUsd: 0.5,
      ms: 2,
      meteredCalls: 1,
      quotaExceeded: false,
    });
    const g = resourceGraph(l);
    expect(g.total).toStrictEqual({ tokens: 1, costUsd: 0.5, ms: 2 });
    expect("customReport" in g).toBe(false);
  });

  it("carries declared units, and prints them in the introspection text", () => {
    const l = log();
    const r = introspect(l, "x", { dimensionUnits: { gpu_seconds: "s" } });
    expect(r.resources.customReport?.units).toEqual({ gpu_seconds: "s" });
    expect(
      analyze(l, { dimensionUnits: { pages_scanned: "pages" } }).cost.customReport?.units
    ).toEqual({
      pages_scanned: "pages",
    });
    expect(formatIntrospection(r, "resources")).toContain("5 s gpu_seconds");
  });

  it("skips what the fold skips: built-in names, prototype names, bad names, bad values", () => {
    seq = 0;
    const custom = JSON.parse(
      '{"tokens":9,"__proto__":3,"constructor":3,"Bad Name":1,"neg":-1,"nan":null,"ok":2}'
    );
    const c = analyze([metered({ custom })]).cost;
    expect(c.custom).toEqual({ ok: 2 });
    expect(Object.getPrototypeOf(c.custom)).toBeNull();
    expect(c.tokens).toBe(0);
  });

  it("caps distinct names per report with an (other) bucket and a warning", () => {
    seq = 0;
    const many: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) many[`dim_${i}`] = 1;
    const l = [
      ev("STEP_STARTED", { stepId: "s" }),
      metered({ custom: many }),
      metered({ custom: many }),
    ];
    const cost = analyze(l).cost;
    const keys = Object.keys(cost.custom ?? {});
    expect(keys.length).toBe(MAX_CUSTOM_DIMENSIONS + 1);
    expect(cost.custom?.[OTHER_DIMENSION]).toBe((5000 - MAX_CUSTOM_DIMENSIONS) * 2);
    expect(cost.custom?.dim_0).toBe(2);
    expect(cost.customReport?.otherNamesCapped).toBe(true); // 4968 > the overflow-name cap
    expect(cost.customReport?.warnings[0]).toContain("capped at 32");

    const g = resourceGraph(l);
    expect(Object.keys(g.total.custom ?? {}).length).toBe(MAX_CUSTOM_DIMENSIONS + 1);
    expect(Object.keys(g.byStep[0]?.custom ?? {}).length).toBe(MAX_CUSTOM_DIMENSIONS + 1);
    expect(formatIntrospection(introspect(l, "x"), "resources")).toContain("warning:");
  });

  it("reports an exact overflow count under the name cap", () => {
    seq = 0;
    const custom: Record<string, number> = {};
    for (let i = 0; i < MAX_CUSTOM_DIMENSIONS + 3; i++) custom[`d${i}`] = 1;
    const r = analyze([metered({ custom })]).cost.customReport;
    expect(r?.otherNames).toBe(3);
    expect(r?.otherNamesCapped).toBe(false);
  });
});
