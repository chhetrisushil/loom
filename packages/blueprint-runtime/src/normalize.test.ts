import { describe, expect, it } from "vitest";
import { blueprint$ } from "./Blueprint";
import { BLUEPRINT_IR_VERSION } from "./irVersion";
import { grid, stack } from "./layout";
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
    expect(BLUEPRINT_IR_VERSION).toBe("2.0.0");
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
    expect(up.irVersion).toBe("2.0.0");
    expect((up.layout as GridLayout).children).toEqual([
      { span: 1, node: w("a") },
      { span: 1, node: stack({ children: [w("b")] }) },
    ]);
    expect(upgradeBlueprint(up)).toBe(up);
    expect(legacy.irVersion).toBeUndefined(); // input untouched
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
