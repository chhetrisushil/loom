import { describe, expect, it } from "vitest";
import { RendererRegistry } from "./RendererRegistry";
import { builtinCatalog, defineWidgetCatalog, validateBlueprint } from "./catalog";
import { catalogCoverage } from "./coverage";
import { customWidget$ } from "./customWidget";
import { grid, stack } from "./layout";
import { cell } from "./normalize";
import type { Blueprint, DataBinding, GridLayout, Layout, Widget } from "./types";
import { DataTable, MetricCard } from "./widgets";

const bp = (children: Array<Widget | Layout>, projections: string[]): Blueprint => ({
  _tag: "Blueprint",
  id: "test",
  title: "Test",
  layout: stack({ children }),
  projections,
});

const codes = (r: { findings: readonly { code: string }[] }) => r.findings.map((f) => f.code);

// ── The positive baseline ─────────────────────────────────────────────────────

describe("validateBlueprint — a well-formed composition", () => {
  it("passes a blueprint built from the built-in builders", () => {
    const report = validateBlueprint(
      bp(
        [
          MetricCard({
            title: "CPU",
            binding: { projectionId: "cpu", path: "current" },
            unit: "%",
          }),
          DataTable({
            title: "Slow queries",
            binding: { projectionId: "queries", path: "slow" },
            columns: ["statement", "calls"],
          }),
        ],
        ["cpu", "queries"]
      ),
      builtinCatalog
    );

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.widgets).toBe(2);
  });

  it("does not mistake the reserved `binding` prop for an undeclared payload", () => {
    // Every built-in builder duplicates the declared binding into `props`. If the
    // allow-list did not reserve that key, every built-in widget in existence
    // would report an undeclared prop — the check would fail closed on itself.
    const widget = MetricCard({
      title: "CPU",
      binding: { projectionId: "cpu", path: "current" },
    });
    expect(Object.keys(widget.props)).toContain("binding");
    expect(validateBlueprint(bp([widget], ["cpu"]), builtinCatalog).ok).toBe(true);
  });

  it("walks nested layouts, not just the top level", () => {
    const report = validateBlueprint(
      bp(
        [grid({ columns: 2, children: [customWidget$({ kind: "Heatmap", props: {} })] })],
        ["cpu"]
      ),
      builtinCatalog
    );
    expect(report.widgets).toBe(1);
    expect(codes(report)).toContain("unknown-kind");
  });

  it("visits every widget in a legacy-grid blueprint (bare children, no GridCell wrapper)", () => {
    // Built WITHOUT grid() — a hand-cast literal, so eachWidget's own asCell handling is
    // what's under test, not the builder's normalisation.
    const legacyLayout = {
      type: "grid",
      columns: 2,
      children: [
        MetricCard({ title: "CPU", binding: { projectionId: "cpu", path: "current" } }),
        stack({
          children: [MetricCard({ title: "Mem", binding: { projectionId: "cpu", path: "mem" } })],
        }),
      ],
    } as unknown as GridLayout;
    const legacyBp: Blueprint = {
      _tag: "Blueprint",
      id: "test",
      title: "Test",
      layout: legacyLayout,
      projections: ["cpu"],
    };
    const report = validateBlueprint(legacyBp, builtinCatalog);
    expect(report.widgets).toBe(2);
    expect(report.ok).toBe(true);
  });
});

// ── The negative cases: each one is the acceptance criterion for a check ──────

describe("validateBlueprint — closure (a composer may only name audited components)", () => {
  it("FAILS a kind the catalogue does not define", () => {
    const report = validateBlueprint(
      bp([customWidget$({ kind: "Heatmap", props: { buckets: 20 } })], ["cpu"]),
      builtinCatalog
    );

    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["unknown-kind"]);
    expect(report.findings[0]?.kind).toBe("Heatmap");
  });

  it("reports ONE finding for one unknown kind, not a cascade", () => {
    // Without an entry there is no allow-list and no binding requirement, so
    // follow-on findings would be invented. One defect, one finding.
    const report = validateBlueprint(
      bp([customWidget$({ kind: "Heatmap", props: { a: 1, b: 2, c: 3 } })], []),
      builtinCatalog
    );
    expect(report.findings).toHaveLength(1);
  });
});

describe("validateBlueprint — bindings, not data (the exfiltration property)", () => {
  it("FAILS an undeclared prop — this is how fetched data gets inlined", () => {
    const report = validateBlueprint(
      bp(
        [
          customWidget$({
            kind: "MetricCard",
            binding: { projectionId: "cpu", path: "current" },
            props: { unit: "%", rows: [{ host: "db-1", pct: 91 }] },
          }),
        ],
        ["cpu"]
      ),
      builtinCatalog
    );

    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["undeclared-prop"]);
    expect(report.findings[0]?.message).toContain("rows");
  });

  it("FAILS a data-bearing component with no binding — it would render blank", () => {
    const report = validateBlueprint(
      bp([customWidget$({ kind: "StatusBadge", props: {} })], []),
      builtinCatalog
    );

    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["missing-binding"]);
  });

  it("WARNS, without failing, on a binding a component declares it does not take", () => {
    const decorative = defineWidgetCatalog({
      id: "test.v1",
      entries: [{ kind: "Divider", props: [], binding: "none" }],
    });
    const report = validateBlueprint(
      bp(
        [
          customWidget$({
            kind: "Divider",
            binding: { projectionId: "cpu", path: "x" },
            props: {},
          }),
        ],
        ["cpu"]
      ),
      decorative
    );

    expect(report.ok).toBe(true);
    expect(codes(report)).toEqual(["unexpected-binding"]);
  });
});

describe("validateBlueprint — silent omission", () => {
  it("FAILS a binding to a projection the blueprint never declares", () => {
    // Renderers hydrate only `blueprint.projections`, so this widget resolves to
    // undefined and renders blank. Nothing else in the system reports it.
    const report = validateBlueprint(
      bp([MetricCard({ title: "CPU", binding: { projectionId: "cpu", path: "current" } })], []),
      builtinCatalog
    );

    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["undeclared-projection"]);
  });

  it("FAILS two widgets that share an id", () => {
    // `stableId` derives the id from kind + props, so two structurally identical
    // widgets collide — and the id is also the renderer's key.
    const one = MetricCard({ title: "CPU", binding: { projectionId: "cpu", path: "current" } });
    const two = MetricCard({ title: "CPU", binding: { projectionId: "cpu", path: "current" } });
    expect(one.id).toBe(two.id);

    const report = validateBlueprint(bp([one, two], ["cpu"]), builtinCatalog);
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["duplicate-node-id"]);
  });
});

describe("validateBlueprint — it is a report, not an exception", () => {
  it("never throws, and returns every finding in one pass", () => {
    const report = validateBlueprint(
      bp(
        [
          customWidget$({ kind: "Heatmap", props: {} }),
          customWidget$({ kind: "StatusBadge", props: {} }),
          MetricCard({ title: "CPU", binding: { projectionId: "nope", path: "x" } }),
        ],
        []
      ),
      builtinCatalog
    );

    expect(report.ok).toBe(false);
    expect(codes(report).sort()).toEqual([
      "missing-binding",
      "undeclared-projection",
      "unknown-kind",
    ]);
  });

  it("counts widgets, so an empty composition is distinguishable from a passing one", () => {
    // `ok: true` over zero widgets is not evidence that a composer works. A
    // first-attempt validation RATE needs this denominator.
    const report = validateBlueprint(bp([], []), builtinCatalog);
    expect(report.ok).toBe(true);
    expect(report.widgets).toBe(0);
  });
});

// ── Coverage: the other direction ─────────────────────────────────────────────

describe("catalogCoverage", () => {
  it("FAILS when a catalogue kind has no renderer", () => {
    const registry = new RendererRegistry<string>().register("MetricCard", "r");
    const report = catalogCoverage(builtinCatalog, registry);

    expect(report.ok).toBe(false);
    expect(report.missing).toContain("DataTable");
    expect(report.missing).not.toContain("MetricCard");
  });

  it("passes when every catalogue kind is registered", () => {
    const registry = new RendererRegistry<string>();
    for (const entry of builtinCatalog.entries) registry.register(entry.kind, "r");
    expect(catalogCoverage(builtinCatalog, registry)).toEqual({
      ok: true,
      missing: [],
      extra: [],
    });
  });

  it("reports a renderer outside the catalogue without failing on it", () => {
    const registry = new RendererRegistry<string>();
    for (const entry of builtinCatalog.entries) registry.register(entry.kind, "r");
    registry.register("Heatmap", "r");

    const report = catalogCoverage(builtinCatalog, registry);
    expect(report.ok).toBe(true);
    expect(report.extra).toEqual(["Heatmap"]);
  });
});

// ── Stable node identity ──────────────────────────────────────────────────────

describe("widget builders — an explicit id survives a revision", () => {
  it("keeps the id across a prop edit, where the derived id would change", () => {
    // The derived id is a hash of kind + props, so editing any prop
    // re-identifies the node — remounting it and breaking anything keyed on it.
    const before = MetricCard({
      title: "CPU",
      binding: { projectionId: "cpu", path: "current" },
    });
    const afterDerived = MetricCard({
      title: "CPU",
      binding: { projectionId: "cpu", path: "current" },
      unit: "%",
    });
    expect(afterDerived.id).not.toBe(before.id);

    const pinned = MetricCard({
      id: "cpu-headline",
      title: "CPU",
      binding: { projectionId: "cpu", path: "current" },
    });
    const revised = MetricCard({
      id: "cpu-headline",
      title: "CPU",
      binding: { projectionId: "cpu", path: "current" },
      unit: "%",
    });
    expect(revised.id).toBe(pinned.id);
  });

  it("keeps `id` out of props, so it is never mistaken for an undeclared payload", () => {
    const widget = DataTable({
      id: "slow-queries",
      title: "Slow queries",
      binding: { projectionId: "queries", path: "slow" },
    });
    expect(Object.keys(widget.props)).not.toContain("id");
    expect(validateBlueprint(bp([widget], ["queries"]), builtinCatalog).ok).toBe(true);
  });

  it("gives two otherwise-identical widgets distinct ids when they are supplied", () => {
    // The duplicate-node-id finding is a real defect of the DERIVED id, not an
    // unavoidable property of blueprints.
    const b = { projectionId: "cpu", path: "current" };
    const report = validateBlueprint(
      bp(
        [
          MetricCard({ id: "a", title: "CPU", binding: b }),
          MetricCard({ id: "z", title: "CPU", binding: b }),
        ],
        ["cpu"]
      ),
      builtinCatalog
    );
    expect(report.ok).toBe(true);
  });
});

describe("validateBlueprint — IR 2.0.0 slots", () => {
  const bind = (path: string, extra: Partial<DataBinding> = {}): DataBinding => ({
    projectionId: "p",
    path,
    ...extra,
  });
  const bp = (layout: Layout, irVersion?: string): Blueprint =>
    ({
      _tag: "Blueprint",
      ...(irVersion !== undefined && { irVersion }),
      id: "b",
      title: "B",
      layout,
      projections: ["p"],
    }) as Blueprint;

  it("a cell span outside 1..columns is span-out-of-range; a nested container cell is checked too", () => {
    const r = validateBlueprint(
      bp(
        grid({
          columns: 4,
          children: [
            cell(5, MetricCard({ id: "m", title: "m", binding: bind("x") })),
            cell(0, stack({ children: [] })),
          ],
        })
      ),
      builtinCatalog
    );
    expect(r.findings.filter((f) => f.code === "span-out-of-range").map((f) => f.nodeId)).toEqual([
      "m",
      "<layout>",
    ]);
    expect(r.ok).toBe(false);
  });
  it("a non-integer span is out of range; span 1..columns is fine; span on a flex child cannot exist by type", () => {
    const r = validateBlueprint(
      bp(
        grid({
          columns: 12,
          children: [
            cell(2.5, MetricCard({ id: "m", title: "m", binding: bind("x") })),
            cell(12, MetricCard({ id: "n", title: "n", binding: bind("y") })),
          ],
        })
      ),
      builtinCatalog
    );
    expect(r.findings.map((f) => f.code)).toEqual(["span-out-of-range"]);
  });
  it("status path must be a non-empty dotted path", () => {
    const bad = MetricCard({ id: "m", title: "m", binding: bind("x", { status: { path: "" } }) });
    const bad2 = MetricCard({
      id: "n",
      title: "n",
      binding: bind("x", { status: { path: "a..b" } }),
    });
    const good = MetricCard({
      id: "o",
      title: "o",
      binding: bind("x", { status: { path: "s.o" } }),
    });
    const r = validateBlueprint(bp(stack({ children: [bad, bad2, good] })), builtinCatalog);
    expect(r.findings.filter((f) => f.code === "status-path-invalid").map((f) => f.nodeId)).toEqual(
      ["m", "n"]
    );
  });
  it("sensitivity must be a DataClass", () => {
    const r = validateBlueprint(
      bp(
        stack({
          children: [
            MetricCard({
              id: "m",
              title: "m",
              binding: bind("x", { sensitivity: "top-secret" as never }),
            }),
          ],
        })
      ),
      builtinCatalog
    );
    expect(r.findings.map((f) => f.code)).toEqual(["sensitivity-unknown"]);
    const ok = validateBlueprint(
      bp(
        stack({
          children: [
            MetricCard({ id: "m", title: "m", binding: bind("x", { sensitivity: "sensitive" }) }),
          ],
        })
      ),
      builtinCatalog
    );
    expect(ok.ok).toBe(true);
  });
  it("source needs a type and version, and every degradedFrom entry needs both", () => {
    const w = MetricCard({ id: "m", title: "m", binding: bind("x") });
    const r = validateBlueprint(
      bp(
        stack({
          children: [
            { ...w, source: { type: "", version: "1" } },
            {
              ...w,
              id: "n",
              source: { type: "Trend", version: "1.0.0", degradedFrom: [{ type: "Collection" }] },
            } as Widget,
            {
              ...w,
              id: "o",
              source: {
                type: "Trend",
                version: "1.0.0",
                degradedFrom: [{ type: "Collection", version: "1.0.0" }],
              },
            },
          ],
        })
      ),
      builtinCatalog
    );
    expect(r.findings.filter((f) => f.code === "source-invalid").map((f) => f.nodeId)).toEqual([
      "m",
      "n",
    ]);
  });
  it("an unknown irVersion is a finding; absent or a pinned version is not", () => {
    expect(
      validateBlueprint(bp(stack({ children: [] }), "9.9.9"), builtinCatalog).findings.map(
        (f) => f.code
      )
    ).toEqual(["ir-version-unknown"]);
    expect(
      validateBlueprint(bp(stack({ children: [] }), "1.0.0"), builtinCatalog).findings
    ).toEqual([]);
    expect(validateBlueprint(bp(stack({ children: [] })), builtinCatalog).findings).toEqual([]);
  });
  it("a literal props.span is undeclared-prop like any other key — span is a cell field, not a prop", () => {
    const r = validateBlueprint(
      bp(
        stack({
          children: [
            MetricCard({ id: "m", title: "m", binding: bind("x"), ...({ span: 4 } as object) }),
          ],
        })
      ),
      builtinCatalog
    );
    expect(r.findings.map((f) => f.code)).toContain("undeclared-prop");
  });
  it("a legacy 1.0.0 blueprint with bare grid children validates clean", () => {
    const legacy = {
      _tag: "Blueprint",
      id: "l",
      title: "L",
      projections: ["p"],
      layout: {
        type: "grid",
        columns: 2,
        children: [MetricCard({ id: "m", title: "m", binding: bind("x") })],
      },
    } as unknown as Blueprint;
    expect(validateBlueprint(legacy, builtinCatalog).ok).toBe(true);
  });
  it("a 2.0.0 artifact is still a known version after the 2.1.0 minor bump", () => {
    expect(
      validateBlueprint(bp(stack({ children: [] }), "2.0.0"), builtinCatalog).findings
    ).toEqual([]);
    expect(
      validateBlueprint(bp(stack({ children: [] }), "2.1.0"), builtinCatalog).findings
    ).toEqual([]);
  });
});

// ── Totality: a blueprint is data a model composed, so the walk must report, never throw ──────

describe("validateBlueprint — malformed structure is a finding, never a throw", () => {
  const bind = (path: string): DataBinding => ({ projectionId: "p", path });
  const bp = (layout: unknown): Blueprint =>
    ({ _tag: "Blueprint", id: "b", title: "B", layout, projections: ["p"] }) as Blueprint;
  const w = (id: string) => MetricCard({ id, title: id, binding: bind("x") });

  it.each([
    ["columns: undefined", undefined],
    ["columns: 0", 0],
    ["columns: 2.5", 2.5],
    ["columns: a string", "2"],
  ])("a grid whose %s is columns-invalid, and its cells' spans are NOT checked", (_n, columns) => {
    const r = validateBlueprint(
      bp({ type: "grid", columns, children: [cell(5, w("m")), cell(0, w("n"))] }),
      builtinCatalog
    );
    expect(codes(r).filter((c) => c === "columns-invalid")).toEqual(["columns-invalid"]);
    expect(codes(r)).not.toContain("span-out-of-range");
    // The grid's own widgets are still walked — the cascade is skipped, not the subtree.
    expect(r.widgets).toBe(2);
    expect(r.ok).toBe(false);
    const finding = r.findings.find((f) => f.code === "columns-invalid");
    expect([finding?.nodeId, finding?.kind]).toEqual(["<layout>", "<layout>"]);
  });

  it.each([
    ["a null child", null],
    ["a string child", "oops"],
    ["a number child", 7],
    ["an undefined child", undefined],
  ])("%s is one malformed-node and does not stop the walk", (_n, child) => {
    const r = validateBlueprint(
      bp({ type: "stack", children: [child, w("after")] }),
      builtinCatalog
    );
    expect(codes(r).filter((c) => c === "malformed-node")).toEqual(["malformed-node"]);
    expect(r.widgets).toBe(1); // the sibling AFTER the malformed child was still visited
    expect(r.findings.find((f) => f.code === "malformed-node")?.nodeId).toBe("<layout>");
  });

  it("a GridCell stranded in a stack is malformed-node — a cell is only meaningful under a grid", () => {
    const r = validateBlueprint(bp({ type: "stack", children: [cell(2, w("m"))] }), builtinCatalog);
    expect(codes(r)).toEqual(["malformed-node"]);
    expect(r.widgets).toBe(0); // the subtree below a malformed node is not walked
  });

  it("a malformed node inside a grid cell is reported once, without throwing", () => {
    const r = validateBlueprint(
      bp({ type: "grid", columns: 2, children: [null, cell(1, w("m"))] }),
      builtinCatalog
    );
    expect(codes(r).filter((c) => c === "malformed-node")).toEqual(["malformed-node"]);
    expect(r.widgets).toBe(1);
  });

  it("source.type/version must be non-empty STRINGS, not merely truthy", () => {
    const r = validateBlueprint(
      bp({
        type: "stack",
        children: [
          { ...w("m"), source: { type: 123, version: {} } } as unknown as Widget,
          {
            ...w("n"),
            source: { type: "Trend", version: "1.0.0", degradedFrom: "Collection" },
          } as unknown as Widget,
          {
            ...w("o"),
            source: { type: "Trend", version: "1.0.0", degradedFrom: [{ type: 1, version: 2 }] },
          } as unknown as Widget,
        ],
      }),
      builtinCatalog
    );
    expect(r.findings.filter((f) => f.code === "source-invalid").map((f) => f.nodeId)).toEqual([
      "m",
      "n",
      "o",
    ]);
  });
});
