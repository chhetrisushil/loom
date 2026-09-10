import { canonicalJson, fnv1a64 } from "@loom/core";
import { describe, expect, it } from "vitest";
import { blueprint$ } from "./Blueprint";
import { stack } from "./layout";
import { blueprintPins, checkBlueprintPins } from "./pins";
import { MetricCard } from "./widgets";

// ADR 0095 — a blueprint's address freezes the NAME a binding resolves through. These tests
// pin the half that makes the name mean something: the recorded version rides inside the
// artifact, and comparing it against the runtime is scoped to what this view actually binds.

function view(projections: string[], projectionVersions?: Record<string, string>) {
  return blueprint$({
    id: "checkout-triage",
    title: "Checkout triage",
    layout: stack({
      children: [
        MetricCard({
          id: "p99",
          title: "p99 latency",
          binding: { projectionId: "latency", path: "p99" },
          unit: "ms",
        }),
      ],
    }),
    projections,
    ...(projectionVersions !== undefined && { projectionVersions }),
  });
}

describe("blueprintPins — what the artifact recorded", () => {
  it("returns the recorded versions of the projections the view declares", () => {
    expect(blueprintPins(view(["latency", "deploys"], { latency: "3", deploys: "1" }))).toEqual({
      latency: "3",
      deploys: "1",
    });
  });

  it("a blueprint that recorded nothing pins nothing (and does not throw)", () => {
    expect(blueprintPins(view(["latency"]))).toEqual({});
  });

  it("drops a pin for a projection the view does not bind", () => {
    // Freezing the meaning of something this view never reads is not evidence about this
    // view, and counting it would inflate `compared` with agreements that mean nothing.
    expect(blueprintPins(view(["latency"], { latency: "3", unrelated: "9" }))).toEqual({
      latency: "3",
    });
  });
});

describe("the pin is part of the content address, not beside it", () => {
  // This is the property the whole ADR turns on: `docs/composed-surfaces.md` lists bindings
  // among the frozen-by-the-address items, and a pin stored anywhere else would leave that
  // claim exactly as true as it was before — which is to say, about a name only.
  const address = (b: unknown) => fnv1a64(canonicalJson(b));

  it("two views differing ONLY in their recorded versions have different addresses", () => {
    expect(address(view(["latency"], { latency: "3" }))).not.toBe(
      address(view(["latency"], { latency: "4" }))
    );
  });

  it("the same view composed twice against the same versions has one address", () => {
    expect(address(view(["latency"], { latency: "3" }))).toBe(
      address(view(["latency"], { latency: "3" }))
    );
  });

  it("survives the JSON round-trip a content store performs", () => {
    const restored = JSON.parse(JSON.stringify(view(["latency"], { latency: "3" })));
    expect(blueprintPins(restored)).toEqual({ latency: "3" });
  });
});

describe("checkBlueprintPins — does this view still mean what it meant?", () => {
  it("an unchanged projection is a pass, and it is counted", () => {
    const report = checkBlueprintPins(view(["latency"], { latency: "3" }), { latency: "3" });
    expect(report.ok).toBe(true);
    expect(report.compared).toBe(1);
  });

  it("an edited fold is an error naming the recorded and current versions", () => {
    const report = checkBlueprintPins(view(["latency"], { latency: "3" }), { latency: "4" });
    expect(report.ok).toBe(false);
    expect(report.findings[0]).toMatchObject({ code: "drift", id: "latency", recorded: "3" });
  });

  it("a declared projection nobody pinned is REPORTED, not silently omitted", () => {
    // The legacy artifact. `ok: true` here is honest only because `compared: 0` and a finding
    // say so — the failure being designed against is a clean report over zero evidence.
    const report = checkBlueprintPins(view(["latency"]), {});
    expect(report.compared).toBe(0);
    expect(report.findings.map((f) => [f.id, f.code])).toEqual([["latency", "unpinned"]]);
  });

  it("a runtime that declares no version cannot verify a recorded one", () => {
    const report = checkBlueprintPins(view(["latency"], { latency: "3" }), {});
    expect(report.findings[0]).toMatchObject({ code: "unpinned", recorded: "3" });
    expect(report.compared).toBe(0);
  });

  it("projections this view does not bind are none of its business", () => {
    // `projectionRuntime.pins()` returns EVERY registered projection; a report that listed
    // them all would bury the one finding that concerns this view.
    const report = checkBlueprintPins(view(["latency"], { latency: "3" }), {
      latency: "3",
      billing: "7",
      inventory: "2",
    });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.compared).toBe(1);
  });
});

describe("a projection id is data, and cannot fall out of the report", () => {
  // Before the maps were built without a prototype, `pins["__proto__"] = v` SET a prototype
  // instead of adding a key: the pin vanished, `Object.keys` never saw it, and the binding
  // dropped out of the comparison with `compared` counting one fewer and no finding at all.
  // Silent omission is the failure this whole seam exists to prevent.

  it("reports a `__proto__` binding rather than dropping it", () => {
    const recorded = JSON.parse('{"__proto__":"1","spend":"1"}');
    const stored = JSON.parse(
      JSON.stringify({
        ...view(["__proto__", "spend"]),
      })
    );
    stored.projectionVersions = recorded;

    expect(Object.keys(blueprintPins(stored)).sort()).toEqual(["__proto__", "spend"]);

    const report = checkBlueprintPins(stored, JSON.parse('{"__proto__":"2","spend":"1"}'));
    expect(report.compared).toBe(2);
    expect(report.findings.map((f) => [f.id, f.code])).toEqual([["__proto__", "drift"]]);
  });

  it("still accounts for a binding whose version could not be recorded", () => {
    // An object LITERAL cannot carry a `__proto__` key at all, so nothing was recorded for
    // it. That has to read as `unpinned` — an absence the caller can see — not as silence.
    const report = checkBlueprintPins(view(["__proto__", "spend"], { spend: "1" }), {
      spend: "1",
    });
    expect(report.compared).toBe(1);
    expect(report.findings.map((f) => [f.id, f.code])).toEqual([["__proto__", "unpinned"]]);
  });
});
