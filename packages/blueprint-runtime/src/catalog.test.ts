import { describe, expect, it } from "vitest";
import { RendererRegistry } from "./RendererRegistry";
import {
  type BlueprintValidation,
  builtinCatalog,
  defineWidgetCatalog,
  validateBlueprint,
} from "./catalog";
import { catalogCoverage } from "./coverage";
import { customWidget$ } from "./customWidget";
import { flex, grid, stack } from "./layout";
import { cell } from "./normalize";
import type { Blueprint, DataBinding, GridCell, GridLayout, Layout, Widget } from "./types";
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
    const undef = { type: "stack", role: undefined, children: [] } as unknown as Layout;
    expect(validateBlueprint(bp(undef), builtinCatalog).findings).toEqual([]);
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
  it("2.1.0 is still a known version after the 2.2.0 minor bump, and 2.2.0 is known (ADR 0099)", () => {
    for (const v of ["2.0.0", "2.1.0", "2.2.0"]) {
      expect(validateBlueprint(bp(stack({ children: [] }), v), builtinCatalog).findings, v).toEqual(
        []
      );
    }
  });
  it("2.2.0 is still a known version after the 2.3.0 minor bump, and 2.3.0 is known (ADR 0100)", () => {
    for (const v of ["2.0.0", "2.1.0", "2.2.0", "2.3.0"]) {
      expect(validateBlueprint(bp(stack({ children: [] }), v), builtinCatalog).findings, v).toEqual(
        []
      );
    }
  });
  it("a binding status is runtime data, so validateBlueprint has no status finding to make (ADR 0100 D5)", () => {
    // The artifact carries only WHERE a status lives (`binding.status.path`); `empty` is a value
    // written into projection state at run time, which validateBlueprint never sees.
    const widget = MetricCard({
      id: "m",
      title: "M",
      binding: { projectionId: "p", path: "v", status: { path: "s" } },
    });
    expect(validateBlueprint(bp(stack({ children: [widget] })), builtinCatalog).findings).toEqual(
      []
    );
  });
  it("a well-formed role is never a finding, known to some renderer or not (ADR 0099 D4)", () => {
    // Whether a renderer has a role registered is registry-dependent, not a loom error.
    for (const role of ["stepped", "no-renderer-has-this", "a", "a--b-", "a".repeat(64)]) {
      const layout = { type: "stack", role, children: [] } as unknown as Layout;
      expect(validateBlueprint(bp(layout), builtinCatalog).findings, role).toEqual([]);
    }
    expect(validateBlueprint(bp(stack({ children: [] })), builtinCatalog).findings).toEqual([]);
    const undef = { type: "stack", role: undefined, children: [] } as unknown as Layout;
    expect(validateBlueprint(bp(undef), builtinCatalog).findings).toEqual([]);
  });
  it("a malformed role is exactly one role-invalid WARN on <layout>, and never fails ok (ADR 0099 D4)", () => {
    const malformed: unknown[] = [
      "Not A Key",
      "",
      "stepped\n",
      "__proto__",
      "a".repeat(65),
      42,
      null,
      { role: "stepped" },
    ];
    for (const role of malformed) {
      for (const layout of [
        { type: "stack", role, children: [] },
        { type: "flex", direction: "row", role, children: [] },
        { type: "grid", columns: 2, role, children: [] },
      ] as unknown as Layout[]) {
        const r = validateBlueprint(bp(layout), builtinCatalog);
        expect(
          r.findings.map((f) => [f.code, f.severity, f.nodeId, f.kind]),
          `${layout.type} ${String(role)}`
        ).toEqual([["role-invalid", "warn", "<layout>", "<layout>"]]);
        expect(r.ok).toBe(true);
      }
    }
  });
  it("role-invalid reports every malformed layout in a nested tree, and bounds what it echoes", () => {
    const huge = "X".repeat(100_000);
    const layout = {
      type: "stack",
      role: huge,
      children: [
        { type: "grid", columns: 2, role: "Bad", children: [] },
        { type: "flex", direction: "row", role: "fine", children: [] },
      ],
    } as unknown as Layout;
    const r = validateBlueprint(bp(layout), builtinCatalog);
    expect(r.findings.map((f) => f.code)).toEqual(["role-invalid", "role-invalid"]);
    for (const f of r.findings) expect(f.message.length).toBeLessThan(400);
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

  describe("source.redacted (IR 2.5.0, ADR 0097 amendment)", () => {
    // The placeholder's kind is the compiler's choice (loom-ui uses `Note`, binding "none"), so a
    // clean placeholder yields NO finding at all — not even `missing-binding` — and the
    // assertions below are on the FULL finding list.
    const cat = { id: "red-cat", entries: [{ kind: "Note", props: [], binding: "none" }] } as never;
    const red = (extra: Record<string, unknown> = {}, source: Record<string, unknown> = {}) =>
      ({
        _tag: "Widget",
        id: "r_1",
        kind: "Note",
        props: {},
        source: { type: "redacted", version: "1", redacted: true, ...source },
        ...extra,
      }) as unknown as Widget;
    const all = (wd: Widget) =>
      validateBlueprint(bp({ type: "stack", children: [wd] }), cat).findings.map((f) => f.code);

    it("accepts the placeholder with NO findings at all", () => {
      expect(all(red())).toEqual([]);
    });
    it("explicit `redacted: undefined` is absent, not invalid", () => {
      expect(all(red({}, { redacted: undefined, type: "t" }))).toEqual([]);
    });
    it("rejects anything but true", () => {
      for (const bad of [false, "true", 1, null, {}])
        expect(all(red({}, { redacted: bad }))).toEqual(["redacted-invalid"]);
    });
    it("rejects a redacted widget that still carries a binding or a degradedFrom chain", () => {
      const binding = { projectionId: "p", path: "secret", sensitivity: "restricted" };
      expect(all(red({ binding }))).toContain("redacted-invalid");
      expect(all(red({}, { degradedFrom: [{ type: "Trend", version: "1.0.0" }] }))).toEqual([
        "redacted-invalid",
      ]);
    });
    it("rejects a title, props, or an original source type/version", () => {
      expect(all(red({ title: "Salary of Alice" }))).toEqual(["redacted-invalid"]);
      expect(all(red({ props: { x: 1 } }))).toContain("redacted-invalid");
      expect(all(red({}, { type: "SalaryTrend" }))).toEqual(["redacted-invalid"]);
      expect(all(red({}, { version: "3" }))).toEqual(["redacted-invalid"]);
    });
    it("still flags a redacted widget of an UNKNOWN kind that carries data", () => {
      const codes = all(red({ kind: "Nope", title: "Salary of Alice" }));
      expect(codes).toContain("unknown-kind");
      expect(codes).toContain("redacted-invalid");
    });
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

describe("validateBlueprint — cell placement (IR 2.1.0, ADR 0098)", () => {
  const m = (id: string) => MetricCard({ id, title: id, binding: { projectionId: "p", path: id } });
  const bpOf = (layout: Layout): Blueprint => ({
    _tag: "Blueprint",
    id: "b",
    title: "B",
    layout,
    projections: ["p"],
  });
  const placementIds = (r: BlueprintValidation) =>
    r.findings.filter((f) => f.code === "placement-out-of-range").map((f) => f.nodeId);

  it("in-range placement is clean, including a cell that ends on the last column", () => {
    const r = validateBlueprint(
      bpOf(
        grid({
          columns: 12,
          children: [
            cell(6, m("a"), { row: 1, column: 1, rowSpan: 2 }),
            cell(6, m("b"), { row: 1, column: 7 }),
            cell(12, m("c"), { row: 3 }),
          ],
        })
      ),
      builtinCatalog
    );
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("row, rowSpan and column must be positive integers", () => {
    const r = validateBlueprint(
      bpOf(
        grid({
          columns: 4,
          children: [
            cell(1, m("r0"), { row: 0 }),
            cell(1, m("rs0"), { rowSpan: 0 }),
            cell(1, m("c0"), { column: 0 }),
            cell(1, m("frac"), { row: 1.5 }),
            cell(1, m("ok"), { row: 2, column: 4, rowSpan: 1 }),
          ],
        })
      ),
      builtinCatalog
    );
    expect(placementIds(r)).toEqual(["r0", "rs0", "c0", "frac"]);
    expect(r.ok).toBe(false);
  });

  it("a cell that starts inside the grid but overflows its right edge is out of range", () => {
    const r = validateBlueprint(
      bpOf(
        grid({
          columns: 12,
          children: [cell(6, m("a"), { column: 8 }), cell(1, m("b"), { column: 13 })],
        })
      ),
      builtinCatalog
    );
    expect(placementIds(r)).toEqual(["a", "b"]);
    expect(r.findings.find((f) => f.nodeId === "a")?.message).toContain("column 8 + span 6");
    expect(r.findings.find((f) => f.nodeId === "b")?.message).toContain("outside 1..12");
  });

  it("one finding per cell however many fields are wrong; a nested container cell reports <layout>", () => {
    const r = validateBlueprint(
      bpOf(
        grid({
          columns: 4,
          children: [
            cell(1, m("a"), { row: -1, column: 9, rowSpan: 0 }),
            cell(2, stack({ children: [] }), { column: 4 }),
          ],
        })
      ),
      builtinCatalog
    );
    expect(placementIds(r)).toEqual(["a", "<layout>"]);
    const msg = r.findings.find((f) => f.nodeId === "a")?.message ?? "";
    expect(msg).toContain("row -1");
    expect(msg).toContain("rowSpan 0");
    expect(msg).toContain("column 9");
  });

  // Regression guard, not new behaviour: this already passes before the placement check exists
  // (span-out-of-range short-circuits before any placement fields are read) — it is here to
  // pin that a bad span never cascades into a SECOND finding once placement checks join it.
  it("a bad span is reported once as span-out-of-range, never again as a placement overflow", () => {
    const r = validateBlueprint(
      bpOf(grid({ columns: 4, children: [cell(9, m("a"), { column: 1 })] })),
      builtinCatalog
    );
    expect(r.findings.map((f) => f.code)).toEqual(["span-out-of-range"]);
  });

  it("a non-number placement in model-composed data is a finding, never a throw", () => {
    const hostile = { span: 1, row: "2", column: null, node: m("a") } as unknown as GridCell;
    const r = validateBlueprint(
      bpOf({ type: "grid", columns: 4, children: [hostile] } as GridLayout),
      builtinCatalog
    );
    expect(placementIds(r)).toEqual(["a"]);
  });

  it("columns-invalid still suppresses the grid's cell checks, placement included", () => {
    const r = validateBlueprint(
      bpOf({ type: "grid", columns: 0, children: [cell(1, m("a"), { column: 5 })] }),
      builtinCatalog
    );
    expect(r.findings.map((f) => f.code)).toEqual(["columns-invalid"]);
  });

  it("an unplaced grid is untouched by the new check (2.0.0 artifacts report what they did)", () => {
    const r = validateBlueprint(
      bpOf(grid({ columns: 2, children: [m("a"), cell(2, m("b"))] })),
      builtinCatalog
    );
    expect(r.findings).toEqual([]);
  });
});

// ── Layout ids (IR 2.4.0, ADR 0101): one node-id namespace with widget ids ────────────────────

describe("validateBlueprint — layout ids (IR 2.4.0, ADR 0101)", () => {
  const bpOf = (layout: Layout, irVersion?: string): Blueprint =>
    ({
      _tag: "Blueprint",
      ...(irVersion !== undefined && { irVersion }),
      id: "b",
      title: "B",
      layout,
      projections: ["p"],
    }) as Blueprint;
  const w = (id: string) =>
    MetricCard({ id, title: id, binding: { projectionId: "p", path: "x" } });
  const rows = (r: BlueprintValidation) =>
    r.findings.map((f) => [f.code, f.severity, f.nodeId, f.kind]);

  it("2.3.0 is still a known version after the 2.4.0 minor bump, and 2.4.0 is known", () => {
    for (const v of ["2.0.0", "2.1.0", "2.2.0", "2.3.0", "2.4.0"]) {
      expect(
        validateBlueprint(bpOf(stack({ children: [] }), v), builtinCatalog).findings,
        v
      ).toEqual([]);
    }
  });

  it("well-formed, distinct layout ids — root included, any non-empty string — are no finding", () => {
    const layout = stack({
      id: "root",
      children: [
        grid({ columns: 2, id: "Account Step", children: [w("a")] }),
        stack({ id: "__proto__", children: [w("b")] }),
        stack({ id: "x".repeat(10_000), children: [] }),
      ],
    });
    expect(validateBlueprint(bpOf(layout), builtinCatalog).findings).toEqual([]);
  });

  it("a layout id colliding with a widget id is duplicate-node-id, on whichever node comes second", () => {
    // Layout first (pre-order), widget second — the widget carries the finding.
    const r1 = validateBlueprint(bpOf(stack({ id: "a", children: [w("a")] })), builtinCatalog);
    expect(r1.ok).toBe(false);
    expect(rows(r1)).toEqual([["duplicate-node-id", "error", "a", "MetricCard"]]);
    // Widget first, layout second — the layout carries it, as kind "<layout>".
    const r2 = validateBlueprint(
      bpOf(stack({ children: [w("a"), stack({ id: "a", children: [] })] })),
      builtinCatalog
    );
    expect(r2.ok).toBe(false);
    expect(rows(r2)).toEqual([["duplicate-node-id", "error", "a", "<layout>"]]);
  });

  it("two layouts sharing an id is duplicate-node-id on the second, kind <layout>", () => {
    const r = validateBlueprint(
      bpOf(
        stack({
          children: [
            stack({ id: "step", children: [w("a")] }),
            flex({ id: "step", children: [w("b")] }),
          ],
        })
      ),
      builtinCatalog
    );
    expect(r.ok).toBe(false);
    expect(rows(r)).toEqual([["duplicate-node-id", "error", "step", "<layout>"]]);
  });

  it("a malformed id is exactly one layout-id-invalid WARN on <layout>, and never fails ok", () => {
    for (const id of ["", 42, null, {}, ["a"], true]) {
      for (const layout of [
        { type: "stack", id, children: [] },
        { type: "flex", direction: "row", id, children: [] },
        { type: "grid", columns: 2, id, children: [] },
      ] as unknown as Layout[]) {
        const r = validateBlueprint(bpOf(layout), builtinCatalog);
        expect(rows(r), `${layout.type} ${JSON.stringify(id)}`).toEqual([
          ["layout-id-invalid", "warn", "<layout>", "<layout>"],
        ]);
        expect(r.ok).toBe(true);
      }
    }
    const undef = { type: "stack", id: undefined, children: [] } as unknown as Layout;
    expect(validateBlueprint(bpOf(undef), builtinCatalog).findings).toEqual([]);
  });

  it("a malformed id is treated as absent: two empty ids are two warnings, not a duplicate", () => {
    const layout = {
      type: "stack",
      children: [
        { type: "stack", id: "", children: [] },
        { type: "stack", id: "", children: [] },
      ],
    } as unknown as Layout;
    const r = validateBlueprint(bpOf(layout), builtinCatalog);
    expect(r.findings.map((f) => f.code)).toEqual(["layout-id-invalid", "layout-id-invalid"]);
    expect(r.ok).toBe(true);
  });

  it("layout-level findings name the layout by its id when it has a valid one", () => {
    const layout = {
      type: "stack",
      id: "root",
      role: "Bad Role",
      children: [
        { type: "grid", id: "g", columns: 0, children: [] },
        { type: "grid", id: "", columns: 0, children: [] },
      ],
    } as unknown as Layout;
    expect(rows(validateBlueprint(bpOf(layout), builtinCatalog))).toEqual([
      ["role-invalid", "warn", "root", "<layout>"],
      ["columns-invalid", "error", "g", "<layout>"],
      ["layout-id-invalid", "warn", "<layout>", "<layout>"],
      ["columns-invalid", "error", "<layout>", "<layout>"],
    ]);
  });

  it("a cell-level finding on a cell wrapping an id'd layout names that layout", () => {
    const layout = grid({
      columns: 2,
      children: [cell(3, stack({ id: "inner", children: [] })), cell(3, stack({ children: [] }))],
    });
    expect(rows(validateBlueprint(bpOf(layout), builtinCatalog))).toEqual([
      ["span-out-of-range", "error", "inner", "<layout>"],
      ["span-out-of-range", "error", "<layout>", "<layout>"],
    ]);
  });
});
