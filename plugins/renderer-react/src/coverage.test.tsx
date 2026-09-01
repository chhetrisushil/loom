import { RendererRegistry, builtinCatalog, catalogCoverage } from "@loom/blueprint-runtime";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it } from "vitest";
import { defaultRegistry } from "./RendererRegistry";
import { AlertCardRenderer, DataTableRenderer, ProgressBarRenderer } from "./renderers";

// ── The catalogue → renderer direction ────────────────────────────────────────
//
// `validateBlueprint` checks that a composer only names components the catalogue
// defines. That is worth nothing if this renderer does not implement everything
// the catalogue defines: the composition validates and the viewer still gets a
// placeholder.
//
// This was live. `WidgetKind` declared eight widgets, `defaultRegistry`
// registered five, and the gap surfaced only as a string in somebody's browser —
// with a test asserting that string, which pinned it as intended behaviour.

describe("defaultRegistry covers the built-in catalogue", () => {
  it("has a renderer for every kind in builtinCatalog", () => {
    const report = catalogCoverage(builtinCatalog, defaultRegistry);
    expect(report.missing, "a vocabulary entry with no renderer reaches the viewer").toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("the check can fail — an incomplete registry is reported, not passed", () => {
    // The negative case. Without it, a coverage assertion that could never fail
    // would read as protection while protecting nothing.
    const stripped = new RendererRegistry<React.FC>().register("MetricCard", () => null);

    const report = catalogCoverage(builtinCatalog, stripped);
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("AlertCard");
  });
});

// ── The three renderers that were missing ─────────────────────────────────────

function renderWidget(Renderer: React.FC<never>, widget: unknown, value: unknown) {
  const Comp = Renderer as React.FC<{ widget: unknown; value: unknown }>;
  return render(<Comp widget={widget} value={value} />);
}

describe("ProgressBarRenderer", () => {
  const widget = {
    _tag: "Widget",
    id: "p1",
    kind: "ProgressBar",
    title: "Pool",
    props: { max: 50 },
  };

  it("renders the value against its max", () => {
    renderWidget(ProgressBarRenderer as never, widget, 25);
    expect(screen.getByText("25 / 50")).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("25");
  });

  it("shows an unresolved binding as unknown, NOT as zero", () => {
    // A bar at 0% and a bar with no data look identical and mean opposite things.
    renderWidget(ProgressBarRenderer as never, widget, undefined);
    expect(screen.getByText("—")).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("value")).toBeNull();
  });
});

describe("DataTableRenderer", () => {
  it("renders declared columns", () => {
    renderWidget(
      DataTableRenderer as never,
      { _tag: "Widget", id: "t1", kind: "DataTable", props: { columns: ["host", "pct"] } },
      [{ host: "db-1", pct: 91 }]
    );
    expect(screen.getByText("db-1")).not.toBeNull();
    expect(screen.getByText("91")).not.toBeNull();
  });

  it("derives columns from the UNION of rows, not the first row", () => {
    // A first-row sample silently drops every column the first row lacks — the
    // table equivalent of a filter nobody asked for.
    renderWidget(
      DataTableRenderer as never,
      { _tag: "Widget", id: "t2", kind: "DataTable", props: {} },
      [{ a: 1 }, { a: 2, b: 3 }]
    );
    expect(screen.getByText("b")).not.toBeNull();
  });

  it("distinguishes an empty result from an unresolved binding", () => {
    renderWidget(
      DataTableRenderer as never,
      { _tag: "Widget", id: "t3", kind: "DataTable", props: {} },
      []
    );
    expect(screen.getByText("no rows")).not.toBeNull();

    renderWidget(
      DataTableRenderer as never,
      { _tag: "Widget", id: "t4", kind: "DataTable", props: {} },
      undefined
    );
    expect(screen.getByText("—")).not.toBeNull();
  });
});

describe("AlertCardRenderer", () => {
  it("renders the bound message at its declared severity", () => {
    const { container } = renderWidget(
      AlertCardRenderer as never,
      { _tag: "Widget", id: "a1", kind: "AlertCard", props: { severity: "critical" } },
      "replica lag exceeded"
    );
    expect(screen.getByText("replica lag exceeded")).not.toBeNull();
    expect(container.querySelector('[data-severity="critical"]')).not.toBeNull();
  });

  it("does not let an unrecognised severity author a style hook", () => {
    const { container } = renderWidget(
      AlertCardRenderer as never,
      { _tag: "Widget", id: "a2", kind: "AlertCard", props: { severity: "'; drop--" } },
      "x"
    );
    expect(container.querySelector('[data-severity="info"]')).not.toBeNull();
  });
});
