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

  it("skips what the fold skips: prototype names, bad names, bad values", () => {
    seq = 0;
    const custom = JSON.parse(
      '{"tokens":9,"__proto__":3,"constructor":3,"Bad Name":1,"neg":-1,"nan":null,"ok":2}'
    );
    const c = analyze([metered({ custom })]).cost;
    // a built-in name inside custom is summed, as the fold does
    expect(c.custom).toEqual({ tokens: 9, ok: 2 });
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

  it("skips a value above the kernel fold's 1e15 ceiling, and sums a built-in name inside custom (as the fold does)", () => {
    seq = 0;
    const l = [
      metered({ custom: { gpu_seconds: 1e20, ok: 1e15, tokens: 5 } }),
      metered({ custom: { gpu_seconds: 2, tokens: 1 } }),
    ];
    expect(analyze(l).cost.custom).toEqual({ gpu_seconds: 2, ok: 1e15, tokens: 6 });
    expect(resourceGraph(l).total.custom).toEqual({ gpu_seconds: 2, ok: 1e15, tokens: 6 });
  });

  it("admits the TOP names by value, so a late high-value name is not buried, in any order", () => {
    const build = (): EventEnvelope[] => {
      seq = 0;
      const evs: EventEnvelope[] = [ev("STEP_STARTED", { stepId: "s" })];
      for (let i = 0; i < MAX_CUSTOM_DIMENSIONS + 5; i++) {
        evs.push(metered({ custom: { [`small_${i}`]: 1 } }));
      }
      evs.push(metered({ custom: { big_late: 1000 } }));
      return evs;
    };
    const l = build();
    const cost = analyze(l).cost;
    expect(cost.custom?.big_late).toBe(1000);
    expect(cost.customReport?.otherNames).toBe(6);
    expect(resourceGraph(l).byStep[0]?.custom?.big_late).toBe(1000);

    // Order independence: reversed and shuffled logs give identical reports.
    const strip = (r: unknown) => JSON.stringify(r);
    const base = strip({ c: costAnalytics(l), g: resourceGraph(l, undefined) });
    const metersOnly = (xs: EventEnvelope[]) =>
      xs.filter((e) => e.eventType === "RESOURCE_METERED");
    const rev = [...metersOnly(l)].reverse();
    const shuffled = [...metersOnly(l)].sort(
      (a, b) => ((a.sequence * 7919) % 31) - ((b.sequence * 7919) % 31)
    );
    const sortedKeys = (c: Record<string, number> | undefined) => Object.entries(c ?? {}).sort();
    const ref = sortedKeys(costAnalytics(metersOnly(l)).custom);
    expect(sortedKeys(costAnalytics(rev).custom)).toEqual(ref);
    expect(sortedKeys(costAnalytics(shuffled).custom)).toEqual(ref);
    expect(costAnalytics(rev).customReport).toEqual(costAnalytics(metersOnly(l)).customReport);
    expect(base.length).toBeGreaterThan(0);
  });

  it("breaks value ties by name, not by first-seen", () => {
    seq = 0;
    const custom: Record<string, number> = {};
    for (let i = MAX_CUSTOM_DIMENSIONS + 1; i >= 0; i--)
      custom[`t${String(i).padStart(2, "0")}`] = 1;
    const c = analyze([metered({ custom })]).cost.custom ?? {};
    expect(c.t00).toBe(1);
    expect(c.t33).toBeUndefined();
    expect(c[OTHER_DIMENSION]).toBe(2);
  });

  it("strips control characters from caller-supplied units when printing", () => {
    seq = 0;
    const l = [ev("STEP_STARTED", { stepId: "s" }), metered({ custom: { gpu_seconds: 2 } })];
    const out = formatIntrospection(
      introspect(l, "x", { dimensionUnits: { gpu_seconds: "s\u001b[2J\u0007\n" } }),
      "resources"
    );
    expect(out).toContain("2 s[2J gpu_seconds");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  });
});
