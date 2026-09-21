import {
  AlertCard,
  ApprovalCard,
  DataTable,
  MetricCard,
  ProgressBar,
  RendererRegistry,
  StatusBadge,
  StreamingText,
  Timeline,
  builtinCatalog,
  catalogCoverage,
} from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { type TerminalWidgetRenderer, defaultTerminalRegistry } from "./defaultRegistry";

// ADR 0088 D1's second direction, for the terminal: does THIS surface render everything the
// catalogue defines? Part II (2026-09-01) recorded that it did not even look. It looks now.

const b = { projectionId: "p", path: "v" };

describe("defaultTerminalRegistry — covers loom's own catalogue", () => {
  it("renders every built-in kind (adding a WidgetKind without a renderer fails here)", () => {
    const report = catalogCoverage(builtinCatalog, defaultTerminalRegistry);
    expect(report.missing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("a registry missing one kind is reported as not covering (negative)", () => {
    const partial = new RendererRegistry<TerminalWidgetRenderer>();
    for (const kind of defaultTerminalRegistry.kinds()) {
      if (kind === "ProgressBar") continue;
      const r = defaultTerminalRegistry.get(kind);
      if (r) partial.register(kind, r);
    }
    const report = catalogCoverage(builtinCatalog, partial);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(["ProgressBar"]);
  });
});

const render = (kind: string, widget: ReturnType<typeof MetricCard>, value: unknown) => {
  const r = defaultTerminalRegistry.get(kind);
  if (!r) throw new Error(`no renderer for ${kind}`);
  return r(widget, value);
};

describe("defaultTerminalRegistry — per-kind output", () => {
  it("MetricCard appends the unit", () => {
    expect(render("MetricCard", MetricCard({ title: "p99", binding: b, unit: "ms" }), 412)).toBe(
      "p99: 412 ms"
    );
  });

  it("StatusBadge brackets the status", () => {
    expect(render("StatusBadge", StatusBadge({ title: "Phase", binding: b }), "triaging")).toBe(
      "Phase: [triaging]"
    );
  });

  it("ProgressBar draws a 20-cell bar against max (default 100) and clamps", () => {
    expect(render("ProgressBar", ProgressBar({ title: "Backfill", binding: b }), 50)).toBe(
      "Backfill: [##########----------] 50%"
    );
    expect(render("ProgressBar", ProgressBar({ title: "Backfill", binding: b, max: 8 }), 8)).toBe(
      "Backfill: [####################] 100%"
    );
    expect(render("ProgressBar", ProgressBar({ title: "Backfill", binding: b }), 250)).toBe(
      "Backfill: [####################] 100%"
    );
    expect(render("ProgressBar", ProgressBar({ title: "Backfill", binding: b }), "n/a")).toBe(
      "Backfill: —"
    );
  });

  it("Timeline bullets items and honours maxItems", () => {
    expect(
      render("Timeline", Timeline({ title: "Events", binding: b, maxItems: 2 }), ["a", "b", "c"])
    ).toBe("Events:\n    • a\n    • b");
  });

  it("DataTable prints a header from columns (or the first row's keys) and one row per line", () => {
    const rows = [
      { db: "orders", p99: 412 },
      { db: "users", p99: 88 },
    ];
    expect(render("DataTable", DataTable({ title: "Top", binding: b }), rows)).toBe(
      "Top:\n    db | p99\n    orders | 412\n    users | 88"
    );
    expect(
      render("DataTable", DataTable({ title: "Top", binding: b, columns: ["p99"] }), rows)
    ).toBe("Top:\n    p99\n    412\n    88");
    expect(render("DataTable", DataTable({ title: "Top", binding: b }), [])).toBe("Top: (empty)");
  });

  it("AlertCard leads with the severity (default info)", () => {
    expect(
      render(
        "AlertCard",
        AlertCard({ title: "Lag", binding: b, severity: "critical" }),
        "3m behind"
      )
    ).toBe("CRITICAL Lag: 3m behind");
    expect(render("AlertCard", AlertCard({ title: "Lag", binding: b }), "ok")).toBe("INFO Lag: ok");
  });

  it("ApprovalCard shows the two labels (defaults Approve / Reject)", () => {
    expect(
      render(
        "ApprovalCard",
        ApprovalCard({ title: "Deploy", binding: b, approveLabel: "Ship", rejectLabel: "Hold" }),
        "v2.3"
      )
    ).toBe("Deploy: v2.3  (Ship / Hold)");
    expect(render("ApprovalCard", ApprovalCard({ title: "Deploy", binding: b }), "v2.3")).toBe(
      "Deploy: v2.3  (Approve / Reject)"
    );
  });

  it("StreamingText falls back to the placeholder, then to an ellipsis", () => {
    expect(
      render(
        "StreamingText",
        StreamingText({ title: "Answer", binding: b, placeholder: "thinking" }),
        undefined
      )
    ).toBe("Answer: thinking");
    expect(render("StreamingText", StreamingText({ title: "Answer", binding: b }), undefined)).toBe(
      "Answer: …"
    );
    expect(render("StreamingText", StreamingText({ title: "Answer", binding: b }), "done")).toBe(
      "Answer: done"
    );
  });
});
