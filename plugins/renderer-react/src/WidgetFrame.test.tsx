import { MetricCard } from "@loom/blueprint-runtime";
import { render } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { WidgetFrame } from "./WidgetFrame";

const widget = MetricCard({
  id: "m",
  title: "p99",
  binding: { projectionId: "p", path: "v", status: { path: "s" } },
});
const rows = [
  {
    status: { state: "error", finding: { code: "x", message: "tool down" } },
    value: 412,
    expectState: "error",
    showsChild: false,
    text: "tool down",
  },
  {
    status: { state: "error", finding: { code: "x", message: "tool down" } },
    value: undefined,
    expectState: "error",
    showsChild: false,
    text: "tool down",
  },
  {
    status: { state: "stale" },
    value: 412,
    expectState: "stale",
    showsChild: true,
    marker: "stale",
  },
  {
    status: { state: "stale", finding: { code: "d", message: "drifted" } },
    value: undefined,
    expectState: "stale",
    showsChild: false,
    text: "no value",
  },
  {
    status: { state: "pending" },
    value: 412,
    expectState: "pending",
    showsChild: true,
    marker: "pending",
  },
  { status: { state: "pending" }, value: undefined, expectState: "loading", showsChild: false },
  { status: { state: "ready" }, value: 412, expectState: "ready", showsChild: true },
  { status: { state: "ready" }, value: undefined, expectState: "loading", showsChild: false },
  // A channel-declaring widget whose status hasn't landed yet (or is
  // malformed) is treated as no status: a present value is shown as "ready"
  // rather than hidden behind a spinner just because the status write hasn't
  // arrived; an absent value still reads as "loading".
  { status: undefined, value: 412, expectState: "ready", showsChild: true },
  { status: undefined, value: undefined, expectState: "loading", showsChild: false },
  // `empty` (IR 2.3.0, ADR 0100): the upstream answered with nothing to show. Ranked right after
  // `error`; a value beside it is IGNORED — the child never renders and no stale value leaks.
  {
    status: { state: "empty" },
    value: undefined,
    expectState: "empty",
    showsChild: false,
    marker: "empty",
    text: "○ p99: no data",
  },
  {
    status: { state: "empty", finding: { code: "upstream-empty", message: "no orders yet" } },
    value: 412,
    expectState: "empty",
    showsChild: false,
    marker: "empty",
    text: "○ p99: no orders yet",
  },
] as const;

describe("WidgetFrame status matrix", () => {
  for (const row of rows) {
    it(`${row.status?.state ?? "undefined"} + ${row.value === undefined ? "no value" : "value"} → ${row.expectState}`, () => {
      const { container } = render(
        <WidgetFrame widget={widget} value={row.value} status={row.status}>
          <span data-child>412</span>
        </WidgetFrame>
      );
      const frame = container.querySelector("[data-widget-frame='m']") as HTMLElement;
      expect(frame.getAttribute("data-binding-state")).toBe(row.expectState);
      expect(container.querySelector("[data-child]") !== null).toBe(row.showsChild);
      if ("marker" in row)
        expect(container.querySelector(`[data-binding-marker='${row.marker}']`)).not.toBeNull();
      if ("text" in row) expect(frame.textContent).toContain(row.text);
      if (row.expectState === "error") expect(frame.querySelector("[role='alert']")).not.toBeNull();
      // `empty` is announced politely, like a status — never as an alert (it is not an error).
      if (row.expectState === "empty") {
        expect(frame.querySelector("[role='status'][data-binding-marker='empty']")).not.toBeNull();
        expect(frame.querySelector("[role='alert']")).toBeNull();
      }
    });
  }
  it("`empty` outranks the check: there is no value to check, so the check is never called", () => {
    const calls: unknown[] = [];
    const check = (_w: unknown, value: unknown) => {
      calls.push(value);
      return { code: "shape", message: "contract" };
    };
    const { container } = render(
      <WidgetFrame widget={widget} value="oops" status={{ state: "empty" }} check={check}>
        <span data-child />
      </WidgetFrame>
    );
    const frame = container.querySelector("[data-widget-frame='m']") as HTMLElement;
    expect(frame.getAttribute("data-binding-state")).toBe("empty");
    expect(frame.textContent).not.toContain("contract");
    expect(frame.textContent).not.toContain("oops");
    expect(calls).toEqual([]);
  });
  it("a channel-LESS widget ignores an `empty` status in the state — the matrix needs a declared channel", () => {
    const plain = MetricCard({ id: "p", title: "p", binding: { projectionId: "p", path: "v" } });
    const { container } = render(
      <WidgetFrame widget={plain} value={412} status={{ state: "empty" }}>
        <span data-child>412</span>
      </WidgetFrame>
    );
    expect(container.querySelector("[data-child]")).not.toBeNull();
    expect(container.querySelector("[data-binding-marker='empty']")).toBeNull();
  });
  it("a widget with NEITHER a status channel NOR a source adds no wrapper at all — 1.0.0 DOM is byte-identical", () => {
    const plain = MetricCard({ id: "p", title: "p", binding: { projectionId: "p", path: "v" } });
    const { container } = render(
      <WidgetFrame widget={plain} value={undefined}>
        <span data-child>—</span>
      </WidgetFrame>
    );
    expect(container.querySelector("[data-child]")).not.toBeNull();
    expect(container.querySelector("[data-widget-frame]")).toBeNull();
  });
  it("a widget with a source but no status channel gets the frame (source attrs, no data-binding-state)", () => {
    const sourced = {
      ...MetricCard({ id: "src-only", title: "p", binding: { projectionId: "p", path: "v" } }),
      source: { type: "Trend", version: "1.0.0" },
    };
    const { container } = render(
      <WidgetFrame widget={sourced} value={412}>
        <span data-child>412</span>
      </WidgetFrame>
    );
    const frame = container.querySelector("[data-widget-frame='src-only']") as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("data-source-type")).toBe("Trend");
    expect(frame.getAttribute("data-source-version")).toBe("1.0.0");
    expect(frame.getAttribute("data-binding-state")).toBeNull();
    expect(container.querySelector("[data-child]")).not.toBeNull();
  });
  // ── The value-contract slot (design §5, ADR 0097 D2) ──────────────────────
  it("a failing check under `stale` renders the error row and suppresses the child", () => {
    const check = (_w: unknown, value: unknown) =>
      value === "oops" ? { code: "shape", message: "not a number" } : undefined;
    const { container } = render(
      <WidgetFrame widget={widget} value="oops" status={{ state: "stale" }} check={check}>
        <span data-child>oops</span>
      </WidgetFrame>
    );
    const frame = container.querySelector("[data-widget-frame='m']") as HTMLElement;
    expect(frame.getAttribute("data-binding-state")).toBe("error");
    expect(frame.querySelector("[role='alert']")?.textContent).toContain("not a number");
    expect(container.querySelector("[data-child]")).toBeNull();
    expect(container.querySelector("[data-binding-marker='stale']")).toBeNull();
  });
  it("a check returning undefined leaves the matrix alone", () => {
    const { container } = render(
      <WidgetFrame widget={widget} value={412} status={{ state: "stale" }} check={() => undefined}>
        <span data-child>412</span>
      </WidgetFrame>
    );
    const frame = container.querySelector("[data-widget-frame='m']") as HTMLElement;
    expect(frame.getAttribute("data-binding-state")).toBe("stale");
    expect(container.querySelector("[data-child]")).not.toBeNull();
  });
  it("a delivery error outranks the check, and a channel-LESS widget is never checked", () => {
    const calls: unknown[] = [];
    const check = () => {
      calls.push(1);
      return { code: "shape", message: "contract" };
    };
    const { container } = render(
      <WidgetFrame
        widget={widget}
        value={1}
        status={{ state: "error", finding: { code: "x", message: "tool down" } }}
        check={check}
      >
        <span data-child />
      </WidgetFrame>
    );
    expect(
      (container.querySelector("[data-widget-frame='m']") as HTMLElement).textContent
    ).toContain("tool down");

    // No channel and no source → the frame returns children untouched, so nothing is checked.
    const plain = MetricCard({ id: "p", title: "p", binding: { projectionId: "p", path: "v" } });
    render(
      <WidgetFrame widget={plain} value="oops" check={check}>
        <span data-child />
      </WidgetFrame>
    );
    expect(calls).toEqual([]);
  });
  it("exposes source as data attributes and a degradation chain with a tooltip", () => {
    const w = {
      ...widget,
      source: {
        type: "Trend",
        version: "1.0.0",
        degradedFrom: [{ type: "Collection", version: "1.0.0" }],
      },
    };
    const { container } = render(
      <WidgetFrame widget={w} value={1} status={{ state: "ready" }}>
        <span />
      </WidgetFrame>
    );
    const frame = container.querySelector("[data-widget-frame='m']") as HTMLElement;
    expect(frame.getAttribute("data-source-type")).toBe("Trend");
    expect(frame.getAttribute("data-source-version")).toBe("1.0.0");
    expect(frame.getAttribute("data-degraded")).toBe("Collection@1.0.0");
    expect(frame.getAttribute("title")).toContain("Collection@1.0.0");
  });
});
