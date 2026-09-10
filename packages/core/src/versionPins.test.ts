import { describe, expect, it } from "vitest";
import { checkVersionPins } from "./versionPins";

// ADR 0095 — the pin compares what an artifact RECORDED against what is registered NOW.
// Every case below is a way the comparison can lie if it is written carelessly, which is why
// each is asserted rather than assumed: a silent pass is exactly the failure this replaces.

describe("checkVersionPins — the comparison", () => {
  it("agreeing versions are a pass, and they are COUNTED", () => {
    const report = checkVersionPins({ latency: "3", deploys: "1" }, { latency: "3", deploys: "1" });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    // The denominator: two ids were genuinely compared, which is what makes `ok` mean
    // something.
    expect(report.compared).toBe(2);
  });

  it("a changed version is an ERROR finding naming both sides", () => {
    const report = checkVersionPins({ latency: "3" }, { latency: "4" });
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      code: "drift",
      severity: "error",
      id: "latency",
      recorded: "3",
      current: "4",
    });
    // Drift is still a comparison that happened.
    expect(report.compared).toBe(1);
  });

  it("an id the artifact recorded but nothing declares now is unpinned, not a match", () => {
    const report = checkVersionPins({ latency: "3" }, {});
    expect(report.findings[0]).toMatchObject({ code: "unpinned", severity: "warn", recorded: "3" });
    // A warning does not clear `ok` — the caller may proceed — but nothing was compared.
    expect(report.ok).toBe(true);
    expect(report.compared).toBe(0);
  });

  it("an id registered now that the artifact never recorded is reported too", () => {
    const report = checkVersionPins({}, { latency: "4" });
    expect(report.findings[0]).toMatchObject({ code: "unpinned", id: "latency", current: "4" });
    expect(report.compared).toBe(0);
  });

  it("two sides that declared NOTHING are not a pass — this is the whole point", () => {
    // The default state of every artifact written before the pin existed. If this returned a
    // clean `ok: true` with no findings, a caller would read "unchanged" from an absence of
    // evidence, which is the vacuous check the pin exists to remove.
    const report = checkVersionPins({ latency: "" }, {});
    expect(report.ok).toBe(true);
    expect(report.compared).toBe(0);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.code).toBe("unpinned");
    expect(report.findings[0]?.message).toContain("nothing about it can be checked");
  });

  it("an empty or whitespace version is a forgotten field, not a version", () => {
    // `{ latency: "" }` on both sides would otherwise compare EQUAL and report a verified
    // match between two derivations that declared nothing about themselves.
    const report = checkVersionPins({ latency: "  " }, { latency: "" });
    expect(report.compared).toBe(0);
    expect(report.findings.map((f) => f.code)).toEqual(["unpinned"]);
  });

  it("versions are compared trimmed, so an editor's stray newline is not a drift", () => {
    expect(checkVersionPins({ latency: "3\n" }, { latency: "3" }).ok).toBe(true);
    expect(checkVersionPins({ latency: "3\n" }, { latency: "3" }).compared).toBe(1);
  });

  it("undefined maps are the legacy case and never throw", () => {
    expect(checkVersionPins(undefined, undefined)).toEqual({ ok: true, findings: [], compared: 0 });
    expect(checkVersionPins(undefined, { latency: "4" }).findings).toHaveLength(1);
  });

  it("reports one finding per id, in recorded order then current-only order", () => {
    const report = checkVersionPins(
      { latency: "3", deploys: "1" },
      { deploys: "2", saturation: "1" }
    );
    expect(report.findings.map((f) => [f.id, f.code])).toEqual([
      ["latency", "unpinned"],
      ["deploys", "drift"],
      ["saturation", "unpinned"],
    ]);
    expect(report.ok).toBe(false);
    expect(report.compared).toBe(1);
  });
});

describe("a pin map is read as data, never as an object", () => {
  // A derivation id is an untrusted string — a model composes the blueprint that names it
  // (ADR 0088) — and a pin map is an ordinary object. A bare index read would answer with
  // `Object.prototype`'s members, so a derivation called `toString` or `constructor` would
  // compare against something nobody recorded.

  it("an inherited member is not a recorded version", () => {
    const report = checkVersionPins({ latency: "1" }, { latency: "1" });
    expect(report.ok).toBe(true);
    // `toString` exists on both maps by inheritance, and neither side declared it.
    expect(report.findings.map((f) => f.id)).not.toContain("toString");
    expect(report.compared).toBe(1);
  });

  it("compares a version recorded under `__proto__` like any other", () => {
    // The real path: a composed blueprint round-trips through the content store, and
    // `JSON.parse` gives `__proto__` an OWN property where an object literal cannot.
    const recorded = JSON.parse('{"__proto__":"1","spend":"1"}');
    const current = JSON.parse('{"__proto__":"2","spend":"1"}');

    const report = checkVersionPins(recorded, current);

    expect(report.compared).toBe(2);
    expect(report.findings.map((f) => [f.id, f.code])).toEqual([["__proto__", "drift"]]);
  });

  it("treats a hostile id with no own entry as undeclared, not as a match", () => {
    const report = checkVersionPins({ constructor: "1" } as Record<string, string>, {});
    expect(report.findings[0]).toMatchObject({ id: "constructor", code: "unpinned" });
    expect(report.compared).toBe(0);
  });
});
