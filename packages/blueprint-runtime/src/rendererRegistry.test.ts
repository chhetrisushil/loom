import { describe, expect, it, vi } from "vitest";
import { RendererRegistry } from "./RendererRegistry";
import { customWidget$ } from "./customWidget";
import { grid, stack } from "./layout";
import { traverseBlueprint } from "./traverseBlueprint";
import type { Layout, Widget } from "./types";
import { MetricCard } from "./widgets";

// ── RendererRegistry ──────────────────────────────────────────────────────────

describe("RendererRegistry", () => {
  it("registers and retrieves a renderer by kind", () => {
    const reg = new RendererRegistry<string>();
    reg.register("MetricCard", "metric-renderer");
    expect(reg.get("MetricCard")).toBe("metric-renderer");
  });

  it("returns undefined for an unregistered kind", () => {
    const reg = new RendererRegistry<string>();
    expect(reg.get("Unknown")).toBeUndefined();
  });

  it("has() reflects registration state", () => {
    const reg = new RendererRegistry<string>();
    expect(reg.has("A")).toBe(false);
    reg.register("A", "a");
    expect(reg.has("A")).toBe(true);
  });

  it("register() is fluent — returns this", () => {
    const reg = new RendererRegistry<string>();
    const returned = reg.register("A", "a");
    expect(returned).toBe(reg);
  });

  it("kinds() lists registered kinds", () => {
    const reg = new RendererRegistry<number>();
    reg.register("X", 1).register("Y", 2);
    expect(reg.kinds().sort()).toEqual(["X", "Y"]);
  });

  it("later register() call overwrites earlier one", () => {
    const reg = new RendererRegistry<string>();
    reg.register("K", "first");
    reg.register("K", "second");
    expect(reg.get("K")).toBe("second");
  });

  it("merge() combines two registries — other wins on conflict", () => {
    const a = new RendererRegistry<string>();
    a.register("Shared", "from-a").register("OnlyA", "a");

    const b = new RendererRegistry<string>();
    b.register("Shared", "from-b").register("OnlyB", "b");

    const merged = a.merge(b);
    expect(merged.get("Shared")).toBe("from-b");
    expect(merged.get("OnlyA")).toBe("a");
    expect(merged.get("OnlyB")).toBe("b");
  });

  it("merge() does not mutate either source registry", () => {
    const a = new RendererRegistry<string>();
    a.register("K", "a");
    const b = new RendererRegistry<string>();
    b.register("K", "b");

    a.merge(b);
    expect(a.get("K")).toBe("a");
    expect(b.get("K")).toBe("b");
  });

  it("accepts custom (non-WidgetKind) kind strings", () => {
    const reg = new RendererRegistry<() => void>();
    const fn = vi.fn();
    reg.register("MyCustomHeatmap", fn);
    expect(reg.get("MyCustomHeatmap")).toBe(fn);
  });
});

// ── customWidget$ ─────────────────────────────────────────────────────────────

describe("customWidget$()", () => {
  it("creates a Widget with the given kind string", () => {
    const w = customWidget$({ kind: "Heatmap", title: "CPU Heat" });
    expect(w._tag).toBe("Widget");
    expect(w.kind).toBe("Heatmap");
    expect(w.title).toBe("CPU Heat");
  });

  it("forwards binding and props", () => {
    const binding = { projectionId: "metrics", path: "cpu.history" };
    const w = customWidget$({ kind: "Heatmap", binding, props: { buckets: 20 } });
    expect(w.binding).toEqual(binding);
    expect(w.props.buckets).toBe(20);
  });

  it("accepts an explicit id", () => {
    const w = customWidget$({ kind: "Foo", id: "my-explicit-id" });
    expect(w.id).toBe("my-explicit-id");
  });

  it("generates a stable id when none is given", () => {
    const w1 = customWidget$({ kind: "Bar", title: "T" });
    const w2 = customWidget$({ kind: "Bar", title: "T" });
    expect(w1.id).toBe(w2.id);
  });
});

// ── traverseBlueprint ─────────────────────────────────────────────────────────

describe("traverseBlueprint()", () => {
  const binding = { projectionId: "metrics", path: "cpu" };
  const stateMap = new Map<string, unknown>([["metrics", { cpu: 72 }]]);

  it("calls renderWidget for a Widget node and returns its result", () => {
    const widget = MetricCard({ title: "CPU", binding });
    const result = traverseBlueprint<string>(widget as unknown as Layout | Widget, stateMap, {
      renderWidget: ({ widget: w, value }) => `${w.kind}:${String(value)}`,
      renderContainer: () => "container",
    });
    expect(result).toBe("MetricCard:72");
  });

  it("resolves nested path values from stateMap", () => {
    const deepMap = new Map<string, unknown>([["m", { a: { b: 99 } }]]);
    const w = customWidget$({ kind: "X", binding: { projectionId: "m", path: "a.b" } });
    const result = traverseBlueprint<number | unknown>(w as unknown as Layout | Widget, deepMap, {
      renderWidget: ({ value }) => value,
      renderContainer: () => null,
    });
    expect(result).toBe(99);
  });

  it("calls renderContainer for a grid layout", () => {
    const widget = MetricCard({ title: "CPU", binding });
    const layout = grid({ columns: 2, children: [widget] });
    const result = traverseBlueprint<string>(layout, stateMap, {
      renderWidget: ({ widget: w }) => `widget:${w.kind}`,
      renderContainer: ({ layout: l, children }) => `${l.type}(${children.join(",")})`,
    });
    expect(result).toBe("grid(widget:MetricCard)");
  });

  it("walks nested layouts recursively", () => {
    const w1 = MetricCard({ title: "A", binding });
    const w2 = MetricCard({ title: "B", binding });
    const layout = stack({ children: [grid({ columns: 2, children: [w1, w2] })] });

    const result = traverseBlueprint<string>(layout, stateMap, {
      renderWidget: ({ widget: w }) => w.title ?? w.kind,
      renderContainer: ({ layout: l, children }) => `[${l.type}:${children.join("|")}]`,
    });
    expect(result).toBe("[stack:[grid:A|B]]");
  });

  it("passes onAction through to renderWidget", () => {
    const onAction = vi.fn();
    const widget = MetricCard({ title: "CPU", binding });
    traverseBlueprint<void>(widget as unknown as Layout | Widget, stateMap, {
      renderWidget: ({ onAction: act }) => act?.({ type: "CLICK", widgetId: "x" }),
      renderContainer: () => undefined,
      onAction,
    });
    expect(onAction).toHaveBeenCalledWith({ type: "CLICK", widgetId: "x" });
  });

  it("returns undefined value for widget without binding", () => {
    const w = customWidget$({ kind: "Empty" });
    const result = traverseBlueprint<unknown>(w as unknown as Layout | Widget, stateMap, {
      renderWidget: ({ value }) => value,
      renderContainer: () => null,
    });
    expect(result).toBeUndefined();
  });
});
