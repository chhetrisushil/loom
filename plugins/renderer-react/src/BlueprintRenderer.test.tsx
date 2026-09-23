import type { Blueprint } from "@loom/blueprint-runtime";
import {
  ApprovalCard,
  MetricCard,
  Timeline,
  blueprint$,
  cell,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintRenderer } from "./BlueprintRenderer";
import { defaultRegistry } from "./RendererRegistry";
import { ApprovalCardRenderer, MetricCardRenderer, TimelineRenderer } from "./renderers";

defaultRegistry.register("MetricCard", MetricCardRenderer);
defaultRegistry.register("Timeline", TimelineRenderer);
defaultRegistry.register("ApprovalCard", ApprovalCardRenderer);

const EXECUTION_ID = "exec-test";

function makeProjectionRuntime(initialCpu = 42, initialApproval = false) {
  const runtime = new InMemoryProjectionRuntime();
  runtime.register({
    id: "metrics",
    initialState: { cpu: { current: initialCpu } },
    handlers: {
      CPU_UPDATED: (_state, event) => {
        const payload = event.payload as { cpu: number };
        return { cpu: { current: payload.cpu } };
      },
    },
  });
  runtime.register({
    id: "incident",
    initialState: { pendingApproval: initialApproval, timeline: [] },
    handlers: {
      APPROVAL_REQUESTED: (state) => ({ ...state, pendingApproval: true }),
    },
  });
  return runtime;
}

const incidentBlueprint = blueprint$({
  id: "incident-dashboard",
  title: "Incident Investigation",
  layout: grid({
    columns: 2,
    children: [
      MetricCard({
        title: "CPU Usage %",
        binding: { projectionId: "metrics", path: "cpu.current" },
      }),
      Timeline({
        title: "Event Timeline",
        binding: { projectionId: "incident", path: "timeline" },
      }),
      ApprovalCard({
        title: "Approve Fix",
        binding: { projectionId: "incident", path: "pendingApproval" },
      }),
    ],
  }),
  projections: ["metrics", "incident"],
});

describe("BlueprintRenderer", () => {
  it("renders all widget kinds without React errors", () => {
    const projectionRuntime = makeProjectionRuntime();
    render(
      <BlueprintRenderer
        blueprint={incidentBlueprint}
        projectionRuntime={projectionRuntime}
        executionId={EXECUTION_ID}
      />
    );

    expect(document.querySelector('[data-widget-kind="MetricCard"]')).not.toBeNull();
    expect(document.querySelector('[data-widget-kind="Timeline"]')).not.toBeNull();
    expect(document.querySelector('[data-widget-kind="ApprovalCard"]')).not.toBeNull();
  });

  it("renders the blueprint title", () => {
    const projectionRuntime = makeProjectionRuntime();
    render(
      <BlueprintRenderer
        blueprint={incidentBlueprint}
        projectionRuntime={projectionRuntime}
        executionId={EXECUTION_ID}
      />
    );
    expect(screen.getByText("Incident Investigation")).not.toBeNull();
  });

  it("displays initial MetricCard value from projection state", () => {
    const projectionRuntime = makeProjectionRuntime(87);
    render(
      <BlueprintRenderer
        blueprint={incidentBlueprint}
        projectionRuntime={projectionRuntime}
        executionId={EXECUTION_ID}
      />
    );
    expect(screen.getByText("87")).not.toBeNull();
  });

  it("updates MetricCard value when projection state changes", () => {
    const projectionRuntime = makeProjectionRuntime(42);
    render(
      <BlueprintRenderer
        blueprint={incidentBlueprint}
        projectionRuntime={projectionRuntime}
        executionId={EXECUTION_ID}
      />
    );

    expect(screen.getByText("42")).not.toBeNull();

    act(() => {
      projectionRuntime.handleEvent({
        id: "e1",
        workflowId: "f1",
        executionId: EXECUTION_ID,
        eventType: "CPU_UPDATED",
        sequence: 1,
        timestamp: Date.now(),
        payload: { cpu: 95 },
      });
    });

    expect(screen.getByText("95")).not.toBeNull();
  });

  it("falls back for unregistered widget kind", () => {
    const noRendererBp = blueprint$({
      id: "fallback-test",
      title: "Fallback",
      layout: grid({
        columns: 1,
        children: [
          {
            _tag: "Widget" as const,
            id: "unknown-1",
            kind: "Sparkline" as const,
            props: {},
            binding: { projectionId: "metrics", path: "cpu.current" },
          },
        ],
      }),
      projections: ["metrics"],
    });

    const projectionRuntime = makeProjectionRuntime();
    render(
      <BlueprintRenderer
        blueprint={noRendererBp}
        projectionRuntime={projectionRuntime}
        executionId={EXECUTION_ID}
      />
    );

    expect(screen.getByText("[No renderer for Sparkline]")).not.toBeNull();
  });
});

describe("BlueprintRenderer — status frame (IR 2.0.0)", () => {
  it("shows data-binding-state='stale' when the projection carries a stale status at the declared path", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register({
      id: "status-metrics",
      initialState: { v: 412, s: { a: { state: "stale" } } },
      handlers: {},
    });
    const bp = blueprint$({
      id: "status-bp",
      title: "Status",
      layout: grid({
        columns: 1,
        children: [
          MetricCard({
            id: "m1",
            title: "p99",
            binding: { projectionId: "status-metrics", path: "v", status: { path: "s.a" } },
          }),
        ],
      }),
      projections: ["status-metrics"],
    });

    render(
      <BlueprintRenderer blueprint={bp} projectionRuntime={runtime} executionId={EXECUTION_ID} />
    );

    expect(
      document.querySelector("[data-widget-frame='m1']")?.getAttribute("data-binding-state")
    ).toBe("stale");
  });

  it("a grid renders the SAME DOM as a stack of the same widgets, modulo the container's own style", () => {
    // ADR 0097 D1: a grid child gains a wrapper element only when its span exceeds 1, so a
    // 1.0.0 grid (every cell implicitly span 1) adds no element the stack does not. If the
    // grid ever wraps its cells again, these two innerHTMLs diverge.
    const widgets = [
      MetricCard({
        id: "same-a",
        title: "CPU",
        binding: { projectionId: "metrics", path: "cpu.current" },
      }),
      Timeline({
        id: "same-b",
        title: "Events",
        binding: { projectionId: "incident", path: "timeline" },
      }),
    ];
    const of = (layout: Blueprint["layout"]) =>
      ({
        _tag: "Blueprint" as const,
        id: "shape",
        title: "Shape",
        layout,
        projections: ["metrics", "incident"],
      }) as Blueprint;

    const gridC = render(
      <BlueprintRenderer
        blueprint={of({
          type: "grid",
          columns: 2,
          children: widgets,
        } as unknown as Blueprint["layout"])}
        projectionRuntime={makeProjectionRuntime()}
        executionId={EXECUTION_ID}
      />
    ).container;
    const stackC = render(
      <BlueprintRenderer
        blueprint={of(stack({ children: widgets }))}
        projectionRuntime={makeProjectionRuntime()}
        executionId={EXECUTION_ID}
      />
    ).container;

    const box = (c: HTMLElement) => c.querySelector("[data-blueprint-id] > div") as HTMLElement;
    expect(box(gridC).innerHTML).toBe(box(stackC).innerHTML);
    // ...and the containers themselves are genuinely different, so the check is not vacuous.
    expect(box(gridC).style.display).toBe("grid");
    expect(box(stackC).style.display).toBe("flex");
  });

  it("renders a legacy bare-children grid blueprint (no GridCell wrapper) without throwing", () => {
    const projectionRuntime = makeProjectionRuntime();
    // A 1.0.0 artifact's grid children are bare Widget nodes, not GridCell
    // wrappers — built by hand here (bypassing the `grid()` builder, which
    // always normalizes through `asCell`) to reproduce that shape.
    const legacyBp = {
      _tag: "Blueprint" as const,
      id: "legacy-bp",
      title: "Legacy",
      layout: {
        type: "grid" as const,
        columns: 1,
        children: [
          MetricCard({
            id: "legacy-m",
            title: "CPU",
            binding: { projectionId: "metrics", path: "cpu.current" },
          }),
        ],
      },
      projections: ["metrics"],
    } as unknown as Blueprint;

    expect(() =>
      render(
        <BlueprintRenderer
          blueprint={legacyBp}
          projectionRuntime={projectionRuntime}
          executionId={EXECUTION_ID}
        />
      )
    ).not.toThrow();
    expect(document.querySelector("[data-widget-id='legacy-m']")).not.toBeNull();
  });
});

// ── The value-contract slot, on BOTH render paths (design §5, ADR 0097 D2) ────

describe("BlueprintRenderer — the check seam", () => {
  const makeRuntime = (state: unknown) => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register({ id: "chk", initialState: state as object, handlers: {} });
    return runtime;
  };
  const bp = blueprint$({
    id: "check-bp",
    title: "Check",
    layout: grid({
      columns: 1,
      children: [
        MetricCard({
          id: "c1",
          title: "p99",
          binding: { projectionId: "chk", path: "v", status: { path: "s" } },
        }),
      ],
    }),
    projections: ["chk"],
  });
  const failing = (_w: unknown, value: unknown) =>
    value === "oops" ? { code: "shape", message: "not a number" } : undefined;

  it.each([
    ["eager", undefined],
    ["fiber", { granularUpdates: true } as const],
  ])(
    "%s: a failing check under `stale` renders the error row; undefined leaves the matrix",
    (_n, fiber) => {
      const bad = render(
        <BlueprintRenderer
          blueprint={bp}
          projectionRuntime={makeRuntime({ v: "oops", s: { state: "stale" } })}
          executionId={EXECUTION_ID}
          check={failing}
          {...(fiber !== undefined && { fiber })}
        />
      ).container;
      const badFrame = bad.querySelector("[data-widget-frame='c1']") as HTMLElement;
      expect(badFrame.getAttribute("data-binding-state")).toBe("error");
      expect(badFrame.querySelector("[role='alert']")?.textContent).toContain("not a number");

      const ok = render(
        <BlueprintRenderer
          blueprint={bp}
          projectionRuntime={makeRuntime({ v: 412, s: { state: "stale" } })}
          executionId={EXECUTION_ID}
          check={failing}
          {...(fiber !== undefined && { fiber })}
        />
      ).container;
      expect(
        (ok.querySelector("[data-widget-frame='c1']") as HTMLElement).getAttribute(
          "data-binding-state"
        )
      ).toBe("stale");
    }
  );
});

describe("BlueprintRenderer — placement and section titles (IR 2.1.0)", () => {
  const placed = blueprint$({
    id: "placed",
    title: "Placed",
    layout: stack({
      title: "Overview",
      children: [
        grid({
          columns: 12,
          children: [
            cell(
              4,
              MetricCard({
                id: "cpu",
                title: "CPU",
                binding: { projectionId: "metrics", path: "cpu.current" },
              }),
              { row: 2, column: 9, rowSpan: 2 }
            ),
          ],
        }),
      ],
    }),
    projections: ["metrics"],
  });

  it.each([
    ["eager", undefined],
    ["fiber", { granularUpdates: true } as const],
  ])("%s: a placed cell and a section title reach the DOM", (_n, fiber) => {
    const { container } = render(
      <BlueprintRenderer
        blueprint={placed}
        projectionRuntime={makeProjectionRuntime()}
        executionId={EXECUTION_ID}
        {...(fiber !== undefined && { fiber })}
      />
    );
    expect(container.querySelector("section > h2")?.textContent).toBe("Overview");
    const widget = container.querySelector("[data-widget-kind='MetricCard']") as HTMLElement;
    const wrapper = widget.closest("[style*='grid-column']") as HTMLElement;
    expect(wrapper.style.gridColumn).toBe("9 / span 4");
    expect(wrapper.style.gridRow).toBe("2 / span 2");
  });
});
