import { describe, expect, it } from "vitest";
import { blueprint$ } from "./Blueprint";
import { flex, grid, stack } from "./layout";
import {
  AlertCard,
  ApprovalCard,
  DataTable,
  MetricCard,
  ProgressBar,
  StatusBadge,
  Timeline,
} from "./widgets";

const binding = { projectionId: "metrics", path: "cpu.current" };

describe("Widget builders", () => {
  it("MetricCard returns correct _tag and kind", () => {
    const w = MetricCard({ title: "CPU %", binding });
    expect(w._tag).toBe("Widget");
    expect(w.kind).toBe("MetricCard");
    expect(w.title).toBe("CPU %");
    expect(w.binding).toEqual(binding);
  });

  it("Timeline returns Widget with kind Timeline", () => {
    const w = Timeline({ binding, title: "Events" });
    expect(w.kind).toBe("Timeline");
  });

  it("ApprovalCard returns Widget with kind ApprovalCard", () => {
    const w = ApprovalCard({ title: "Approve", binding });
    expect(w.kind).toBe("ApprovalCard");
  });

  it("StatusBadge, ProgressBar, DataTable, AlertCard build correctly", () => {
    expect(StatusBadge({ binding }).kind).toBe("StatusBadge");
    expect(ProgressBar({ binding }).kind).toBe("ProgressBar");
    expect(DataTable({ binding }).kind).toBe("DataTable");
    expect(AlertCard({ binding }).kind).toBe("AlertCard");
  });

  it("widget IDs are stable — same props produce same id", () => {
    const w1 = MetricCard({ title: "CPU", binding });
    const w2 = MetricCard({ title: "CPU", binding });
    expect(w1.id).toBe(w2.id);
  });

  it("widget IDs differ for different props", () => {
    const w1 = MetricCard({ title: "CPU", binding });
    const w2 = MetricCard({ title: "Memory", binding });
    expect(w1.id).not.toBe(w2.id);
  });
});

describe("Layout builders", () => {
  it("grid() creates a GridLayout", () => {
    const l = grid({ columns: 2, children: [] });
    expect(l.type).toBe("grid");
    expect(l.columns).toBe(2);
  });

  it("flex() creates a FlexLayout with default direction", () => {
    const l = flex({ children: [] });
    expect(l.type).toBe("flex");
    expect(l.direction).toBe("row");
  });

  it("stack() creates a StackLayout", () => {
    const l = stack({ children: [] });
    expect(l.type).toBe("stack");
  });
});

describe("blueprint$()", () => {
  it("returns a Blueprint with correct _tag", () => {
    const bp = blueprint$({
      id: "incident-dashboard",
      title: "Incident Dashboard",
      layout: grid({ columns: 2, children: [] }),
      projections: ["metrics", "incident"],
    });
    expect(bp._tag).toBe("Blueprint");
    expect(bp.id).toBe("incident-dashboard");
    expect(bp.projections).toEqual(["metrics", "incident"]);
  });

  it("serializes and deserializes via JSON without data loss", () => {
    const bp = blueprint$({
      id: "test-bp",
      title: "Test",
      layout: grid({
        columns: 2,
        children: [
          MetricCard({ title: "CPU", binding: { projectionId: "metrics", path: "cpu.current" } }),
          Timeline({ binding: { projectionId: "metrics", path: "timeline" } }),
          ApprovalCard({
            title: "Approve",
            binding: { projectionId: "incident", path: "pendingApproval" },
          }),
        ],
      }),
      projections: ["metrics", "incident"],
    });

    const serialized = JSON.stringify(bp);
    const parsed = JSON.parse(serialized) as typeof bp;

    expect(parsed).toEqual(bp);
    expect(parsed._tag).toBe("Blueprint");
    expect((parsed.layout as ReturnType<typeof grid>).children).toHaveLength(3);
  });

  it("blueprint has no circular references (JSON.stringify does not throw)", () => {
    const bp = blueprint$({
      id: "circular-test",
      title: "Test",
      layout: stack({
        children: [MetricCard({ title: "A", binding }), MetricCard({ title: "B", binding })],
      }),
      projections: [],
    });
    expect(() => JSON.stringify(bp)).not.toThrow();
  });
});
