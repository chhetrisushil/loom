import { describe, expect, it } from "vitest";
import { blueprint$ } from "./Blueprint";
import { blueprintNodeIds, preservesBlueprintNodes, preservesNodes } from "./identity";
import { grid, stack } from "./layout";
import type { GridLayout, Layout } from "./types";
import { MetricCard, StatusBadge } from "./widgets";

const binding = { projectionId: "db", path: "latency" };

const metric = (title: string, id?: string) =>
  MetricCard({ title, binding, ...(id !== undefined && { id }) });

describe("blueprintNodeIds", () => {
  it("walks nested containers in pre-order", () => {
    const view = blueprint$({
      id: "v",
      title: "v",
      layout: stack({
        children: [
          metric("Latency", "latency"),
          grid({ columns: 2, children: [metric("Locks", "locks"), metric("Plan", "plan")] }),
        ],
      }),
      projections: ["db"],
    });
    expect(blueprintNodeIds(view)).toEqual(["latency", "locks", "plan"]);
  });

  it("returns ids in pre-order for a legacy-grid blueprint (bare children, no GridCell wrapper), including one nested in a stack inside the grid", () => {
    // Built WITHOUT grid() — a hand-cast literal, so blueprintNodeIds's own asCell handling
    // is what's under test, not the builder's normalisation.
    const legacyLayout = {
      type: "grid",
      columns: 2,
      children: [metric("Latency", "latency"), stack({ children: [metric("Locks", "locks")] })],
    } as unknown as GridLayout;
    const view = blueprint$({
      id: "v",
      title: "v",
      layout: legacyLayout,
      projections: ["db"],
    });
    expect(blueprintNodeIds(view)).toEqual(["latency", "locks"]);
  });

  it("does not stop at an undefined stack child that precedes real widgets (a malformed node, e.g. an agent-authored hole)", () => {
    // `stack.pop()` on an empty stack and `stack.pop()` on a stack whose next element IS
    // `undefined` are indistinguishable to a `!== undefined` loop guard — the walk must not
    // confuse "nothing left" with "this slot is a hole". Rejecting the hole is
    // `validateBlueprint`'s job; this walk must stay total and keep going past it.
    const legacyLayout = {
      type: "stack",
      children: [undefined, metric("Latency", "latency"), metric("Locks", "locks")],
    } as unknown as Layout;
    const view = blueprint$({
      id: "v",
      title: "v",
      layout: legacyLayout,
      projections: ["db"],
    });
    expect(blueprintNodeIds(view)).toEqual(["latency", "locks"]);
  });

  it("does not stop at a grid cell whose node is undefined (e.g. cell(6, undefined))", () => {
    const legacyLayout = {
      type: "grid",
      columns: 3,
      children: [undefined, metric("Latency", "latency"), metric("Locks", "locks")],
    } as unknown as GridLayout;
    const view = blueprint$({
      id: "v",
      title: "v",
      layout: legacyLayout,
      projections: ["db"],
    });
    expect(blueprintNodeIds(view)).toEqual(["latency", "locks"]);
  });
});

describe("preservesNodes", () => {
  it("reports what a change dropped, and lists what it added", () => {
    const report = preservesNodes(["a", "b"], ["a", "c"]);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.nodeId)).toEqual(["b"]);
    expect(report.findings[0]?.code).toBe("dropped-node-id");
    expect(report.added).toEqual(["c"]);
    expect(report.compared).toBe(2);
  });

  it("adding is not a defect — a variant may sit above a floor", () => {
    const report = preservesNodes(["floor-1", "floor-2"], ["floor-1", "floor-2", "extra"]);
    expect(report.ok).toBe(true);
    expect(report.added).toEqual(["extra"]);
  });

  it("counts a repeated id once, so one lost node is one finding", () => {
    const report = preservesNodes(["a", "a", "b"], ["b"]);
    expect(report.findings).toHaveLength(1);
    expect(report.compared).toBe(2);
  });

  it("an empty `before` is not evidence of anything, and says so", () => {
    // ok:true over nothing compared is the vacuous pass this field exists to expose: a
    // caller computing a floor that came back empty would otherwise read a clean report.
    const report = preservesNodes([], ["a"]);
    expect(report.ok).toBe(true);
    expect(report.compared).toBe(0);
  });
});

describe("preservesBlueprintNodes — the derived-id trap", () => {
  const view = (title: string, id?: string) =>
    blueprint$({
      id: "v",
      title: "v",
      layout: stack({ children: [metric(title, id), StatusBadge({ title: "S", binding })] }),
      projections: ["db"],
    });

  it("catches a prop edit re-identifying a node that supplied no id", () => {
    // The whole hazard in four lines: the composer meant to retitle one card, and the
    // node it retitled is — to every pin, annotation and client key — a different node.
    const report = preservesBlueprintNodes(view("Latency"), view("Latency (p99)"));
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.added).toHaveLength(1); // the same card, under its new identity
  });

  it("stays quiet when the node carries an explicit id", () => {
    const report = preservesBlueprintNodes(
      view("Latency", "latency"),
      view("Latency (p99)", "latency")
    );
    expect(report.ok).toBe(true);
    expect(report.added).toEqual([]);
  });

  it("compares every id even when an undefined child precedes them on both sides", () => {
    // If `blueprintNodeIds` truncated at the hole, `before` and `after` would each collect
    // only zero ids and `compared` would read as a vacuous pass, not the real dropped id.
    const before = {
      type: "stack",
      children: [undefined, metric("Latency", "latency"), metric("Locks", "locks")],
    } as unknown as Layout;
    const after = {
      type: "stack",
      children: [undefined, metric("Latency", "latency")],
    } as unknown as Layout;
    const report = preservesBlueprintNodes(
      blueprint$({ id: "v", title: "v", layout: before, projections: ["db"] }),
      blueprint$({ id: "v", title: "v", layout: after, projections: ["db"] })
    );
    expect(report.compared).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.nodeId)).toEqual(["locks"]);
  });
});
