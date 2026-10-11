import { canonicalJson, fnv1a64 } from "@loom/core";
import { describe, expect, it } from "vitest";
import { blueprint$ } from "./Blueprint";
import { BLUEPRINT_IR_VERSION } from "./irVersion";
import { flex, grid, isLayoutId, isLayoutRole, stack } from "./layout";
import {
  IR_VERSION_LEGACY,
  asCell,
  blueprintIrVersion,
  cell,
  isBindingStatus,
  resolveWidgetStatus,
  upgradeBlueprint,
} from "./normalize";
import type { Blueprint, GridLayout, Widget } from "./types";
import { MetricCard } from "./widgets";

const w = (id: string, status?: { path: string }): Widget =>
  MetricCard({
    id,
    title: id,
    binding: { projectionId: "p", path: `v.${id}`, ...(status && { status }) },
  });

describe("asCell / cell", () => {
  it("wraps a bare widget or layout as a span-1 cell and returns a cell unchanged", () => {
    expect(asCell(w("a"))).toEqual({ span: 1, node: w("a") });
    const s = stack({ children: [w("b")] });
    expect(asCell(s)).toEqual({ span: 1, node: s });
    const c = cell(4, w("c"));
    expect(asCell(c)).toBe(c);
    expect(c).toEqual({ span: 4, node: w("c") });
  });
  it("grid() normalises mixed children so authoring code does not change", () => {
    const g = grid({
      columns: 12,
      children: [w("a"), cell(8, w("b")), stack({ children: [w("c")] })],
    });
    expect(g.children.map((c) => c.span)).toEqual([1, 8, 1]);
    expect(g.children[1]?.node).toEqual(w("b"));
  });
});

describe("irVersion", () => {
  it("blueprint$ stamps the current IR version; an unstamped artifact is legacy", () => {
    const bp = blueprint$({
      id: "x",
      title: "X",
      layout: stack({ children: [] }),
      projections: [],
    });
    expect(bp.irVersion).toBe(BLUEPRINT_IR_VERSION);
    expect(BLUEPRINT_IR_VERSION).toBe("2.4.0");
    const { irVersion: _v, ...legacy } = bp;
    expect(blueprintIrVersion(legacy as Blueprint)).toBe(IR_VERSION_LEGACY);
  });
  it("upgradeBlueprint wraps legacy bare grid children, stamps the version, and is identity on 2.0.0 input", () => {
    const legacyGrid = {
      type: "grid",
      columns: 12,
      children: [w("a"), stack({ children: [w("b")] })],
    } as unknown as GridLayout;
    const legacy = {
      _tag: "Blueprint",
      id: "l",
      title: "L",
      layout: legacyGrid,
      projections: ["p"],
    } as Blueprint;
    const up = upgradeBlueprint(legacy);
    expect(up.irVersion).toBe(BLUEPRINT_IR_VERSION);
    expect((up.layout as GridLayout).children).toEqual([
      { span: 1, node: w("a") },
      { span: 1, node: stack({ children: [w("b")] }) },
    ]);
    expect(upgradeBlueprint(up)).toBe(up);
    expect(legacy.irVersion).toBeUndefined(); // input untouched
  });
  it("upgradeBlueprint CHANGES a 1.0.0 artifact's content address, and a second upgrade is a no-op", () => {
    // ADR 0097 D1/Consequences: "a 1.0.0 artifact re-emitted as 2.0.0 has a different content
    // address, precisely because its shape changed". The digest is what makes that claim
    // checkable rather than a paragraph — and the second half (identity on 2.0.0 input) is what
    // stops a reader that upgrades defensively from re-addressing the same artifact forever.
    const legacy = {
      _tag: "Blueprint",
      id: "l",
      title: "L",
      projections: ["p"],
      layout: { type: "grid", columns: 2, children: [w("a")] },
    } as unknown as Blueprint;
    const address = (bp: Blueprint) => fnv1a64(canonicalJson(bp));

    const before = address(legacy);
    const up = upgradeBlueprint(legacy);
    expect(address(up)).not.toBe(before);

    const again = upgradeBlueprint(up);
    expect(again).toBe(up); // same reference, not merely an equal value
    expect(address(again)).toBe(address(up));
    expect(address(legacy)).toBe(before); // the input was never mutated
  });
  it("upgradeBlueprint reaches a grid nested inside a stack", () => {
    const legacy = {
      _tag: "Blueprint",
      id: "l",
      title: "L",
      projections: [],
      layout: { type: "stack", children: [{ type: "grid", columns: 2, children: [w("a")] }] },
    } as unknown as Blueprint;
    const inner = (upgradeBlueprint(legacy).layout as { children: GridLayout[] }).children[0];
    expect(inner?.children).toEqual([{ span: 1, node: w("a") }]);
  });
});

describe("status resolution", () => {
  it("isBindingStatus accepts `empty` (IR 2.3.0, ADR 0100), with or without a finding, under the same rules as every other state", () => {
    expect(isBindingStatus({ state: "empty" })).toBe(true);
    expect(
      isBindingStatus({
        state: "empty",
        seq: 4,
        finding: { code: "upstream-empty", message: "no rows" },
      })
    ).toBe(true);
    expect(isBindingStatus({ state: "empty", seq: "4" })).toBe(false);
    expect(isBindingStatus({ state: "empty", finding: { code: "upstream-empty" } })).toBe(false);
    // Near-misses are not `empty`: the literal is exact and case-sensitive.
    for (const state of ["Empty", "EMPTY", "empty ", "no-data", "none"])
      expect(isBindingStatus({ state }), state).toBe(false);
  });
  it("resolveWidgetStatus resolves an `empty` status from the declared path like any other state", () => {
    const map = new Map<string, unknown>([["p", { v: {}, s: { a: { state: "empty", seq: 2 } } }]]);
    const widget = MetricCard({
      id: "a",
      title: "A",
      binding: { projectionId: "p", path: "v.a", status: { path: "s.a" } },
    });
    expect(resolveWidgetStatus(widget, map)).toEqual({ state: "empty", seq: 2 });
  });
  it("isBindingStatus accepts the four states with optional seq/finding and rejects everything else", () => {
    expect(isBindingStatus({ state: "ready" })).toBe(true);
    expect(
      isBindingStatus({ state: "stale", seq: 3, finding: { code: "drift", message: "m" } })
    ).toBe(true);
    expect(isBindingStatus({ state: "loading" })).toBe(false);
    expect(isBindingStatus({ state: "ready", seq: "3" })).toBe(false);
    expect(isBindingStatus({ state: "error", finding: { code: "x" } })).toBe(false);
    expect(isBindingStatus(null)).toBe(false);
    expect(isBindingStatus("ready")).toBe(false);
  });
  it("resolves status from the SAME projection state as the value, only when the binding declares a channel", () => {
    const state = { v: { a: 1 }, s: { a: { state: "pending", seq: 1 } } };
    const map = new Map<string, unknown>([["p", state]]);
    expect(resolveWidgetStatus(w("a", { path: "s.a" }), map)).toEqual({ state: "pending", seq: 1 });
    expect(resolveWidgetStatus(w("a"), map)).toBeUndefined();
    expect(resolveWidgetStatus(w("a", { path: "s.missing" }), map)).toBeUndefined();
    map.set("p", { v: { a: 1 }, s: { a: { state: 42 } } });
    expect(resolveWidgetStatus(w("a", { path: "s.a" }), map)).toBeUndefined();
  });
});

describe("placement and titles (IR 2.1.0, ADR 0098)", () => {
  it("cell() carries optional placement and writes only the fields given", () => {
    expect(cell(4, w("a"), { row: 2, column: 5, rowSpan: 3 })).toEqual({
      span: 4,
      node: w("a"),
      row: 2,
      column: 5,
      rowSpan: 3,
    });
    expect(Object.keys(cell(4, w("b"))).sort()).toEqual(["node", "span"]);
    expect(Object.keys(cell(1, w("c"), { row: 1 })).sort()).toEqual(["node", "row", "span"]);
  });
  it("asCell and grid() keep a placed cell exactly as given", () => {
    const placed = cell(6, w("a"), { row: 1, column: 7 });
    expect(asCell(placed)).toBe(placed);
    const g = grid({ columns: 12, children: [placed, w("b")] });
    expect(g.children[0]).toBe(placed);
    expect(g.children[1]).toEqual({ span: 1, node: w("b") });
  });
  it("grid, flex and stack take an optional title and omit the key when it is absent", () => {
    expect(grid({ columns: 2, title: "Latency", children: [] }).title).toBe("Latency");
    expect(flex({ title: "Row", children: [] }).title).toBe("Row");
    expect(stack({ title: "Column", children: [] }).title).toBe("Column");
    expect("title" in grid({ columns: 2, children: [] })).toBe(false);
    expect("title" in flex({ children: [] })).toBe(false);
    expect("title" in stack({ children: [] })).toBe(false);
  });
  it("upgradeBlueprint is identity on a 2.0.0 artifact — a minor bump never re-addresses stored content", () => {
    const v200: Blueprint = {
      ...blueprint$({
        id: "x",
        title: "X",
        layout: grid({ columns: 2, children: [w("a")] }),
        projections: ["p"],
      }),
      irVersion: "2.0.0",
    };
    expect(upgradeBlueprint(v200)).toBe(v200);
  });
  it("upgradeBlueprint keeps placement and titles when it wraps a 1.0.0 grid", () => {
    const legacy = {
      _tag: "Blueprint",
      id: "l",
      title: "L",
      projections: ["p"],
      layout: {
        type: "stack",
        title: "Overview",
        children: [
          { type: "grid", columns: 4, children: [w("a"), cell(2, w("b"), { row: 1, column: 3 })] },
        ],
      },
    } as unknown as Blueprint;
    const up = upgradeBlueprint(legacy);
    expect(up.layout.title).toBe("Overview");
    const inner = (up.layout as { children: GridLayout[] }).children[0];
    expect(inner?.children).toEqual([
      { span: 1, node: w("a") },
      { span: 2, node: w("b"), row: 1, column: 3 },
    ]);
  });
});

describe("layout roles (IR 2.2.0, ADR 0099)", () => {
  it("grid, flex and stack take an optional role and omit the key when it is absent", () => {
    expect(grid({ columns: 2, role: "stepped", children: [] }).role).toBe("stepped");
    expect(flex({ role: "tabbed", children: [] }).role).toBe("tabbed");
    expect(stack({ role: "collapsible", children: [] }).role).toBe("collapsible");
    expect("role" in grid({ columns: 2, children: [] })).toBe(false);
    expect("role" in flex({ children: [] })).toBe(false);
    expect("role" in stack({ children: [] })).toBe(false);
  });
  it("an absent role leaves a layout's content address exactly as 2.1.0 wrote it", () => {
    const digest = (v: unknown) => fnv1a64(canonicalJson(v));
    const before = { type: "stack", title: "T", children: [w("a")] };
    expect(digest(stack({ title: "T", children: [w("a")] }))).toBe(digest(before));
    expect(digest(stack({ title: "T", role: "stepped", children: [w("a")] }))).not.toBe(
      digest(before)
    );
  });
  it("upgradeBlueprint is identity on 2.1.0 and 2.2.0 artifacts, and keeps a role when it wraps 1.0.0", () => {
    for (const irVersion of ["2.1.0", "2.2.0", "2.3.0"]) {
      const v: Blueprint = {
        ...blueprint$({
          id: "x",
          title: "X",
          layout: stack({ role: "stepped", children: [w("a")] }),
          projections: ["p"],
        }),
        irVersion,
      };
      expect(upgradeBlueprint(v)).toBe(v);
    }
    const legacy = {
      _tag: "Blueprint",
      id: "l",
      title: "L",
      projections: ["p"],
      layout: { type: "grid", columns: 2, role: "tabbed", children: [w("a")] },
    } as unknown as Blueprint;
    expect(upgradeBlueprint(legacy).layout.role).toBe("tabbed");
  });
  it("isLayoutRole accepts a lowercase registry key of at most 64 characters", () => {
    // Trailing and doubled hyphens are accepted (ADR 0099 D2): the rule is a key's alphabet and
    // length, not a style guide.
    for (const ok of [
      "stepped",
      "tabbed",
      "a",
      "lu-stepped",
      "step2",
      "a-",
      "a--b",
      "a".repeat(64),
    ]) {
      expect(isLayoutRole(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "stepped\n",
      " stepped",
      "Stepped",
      "2step",
      "-stepped",
      "stepped panel",
      "stepped_panel",
      "stepped.panel",
      "région",
      "a".repeat(65),
      "__proto__",
      undefined,
      null,
      42,
      {},
    ]) {
      expect(isLayoutRole(bad), String(bad)).toBe(false);
    }
  });
});

describe("layout ids (IR 2.4.0, ADR 0101)", () => {
  it("isLayoutId accepts any non-empty string — Widget.id's rule, no charset, no cap", () => {
    for (const ok of ["a", "1", "0", "__proto__", "Account Step", "x".repeat(10_000)]) {
      expect(isLayoutId(ok), ok).toBe(true);
    }
    for (const bad of ["", undefined, null, 0, 42, {}, ["a"], true]) {
      expect(isLayoutId(bad), String(bad)).toBe(false);
    }
  });
  it("grid, flex and stack take an optional id and omit the key when it is absent", () => {
    expect(grid({ columns: 2, id: "g", children: [] }).id).toBe("g");
    expect(flex({ id: "f", children: [] }).id).toBe("f");
    expect(stack({ id: "s", children: [] }).id).toBe("s");
    expect("id" in grid({ columns: 2, children: [] })).toBe(false);
    expect("id" in flex({ children: [] })).toBe(false);
    expect("id" in stack({ children: [] })).toBe(false);
  });
  it("an absent id leaves a layout's content address exactly as 2.3.0 wrote it; a present one enters it", () => {
    const digest = (v: unknown) => fnv1a64(canonicalJson(v));
    const before = { type: "stack", title: "T", role: "stepped", children: [w("a")] };
    expect(digest(stack({ title: "T", role: "stepped", children: [w("a")] }))).toBe(digest(before));
    const withId = digest(stack({ id: "s", title: "T", role: "stepped", children: [w("a")] }));
    expect(withId).not.toBe(digest(before));
    // The id is part of the address: re-identifying a container is a different artifact.
    expect(withId).not.toBe(
      digest(stack({ id: "s2", title: "T", role: "stepped", children: [w("a")] }))
    );
  });
  it("upgradeBlueprint is identity on 2.3.0 and 2.4.0 artifacts, and keeps a layout id when it wraps 1.0.0", () => {
    for (const irVersion of ["2.3.0", "2.4.0"]) {
      const v: Blueprint = {
        ...blueprint$({
          id: "x",
          title: "X",
          layout: stack({ id: "root", children: [w("a")] }),
          projections: ["p"],
        }),
        irVersion,
      };
      expect(upgradeBlueprint(v)).toBe(v);
    }
    const legacy = {
      _tag: "Blueprint",
      id: "l",
      title: "L",
      projections: ["p"],
      layout: { type: "grid", columns: 2, id: "g", children: [w("a")] },
    } as unknown as Blueprint;
    expect(upgradeBlueprint(legacy).layout.id).toBe("g");
  });
});
