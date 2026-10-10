import type { Blueprint } from "@loom/blueprint-runtime";
import {
  ApprovalCard,
  MetricCard,
  Timeline,
  blueprint$,
  cell,
  customWidget$,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlueprintRenderer } from "./BlueprintRenderer";
import { RendererRegistry, type WidgetRenderer, defaultRegistry } from "./RendererRegistry";
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

  it("shows the `empty` row when the projection carries an `empty` status, and never the value beside it (IR 2.3.0, ADR 0100)", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register({
      id: "empty-metrics",
      initialState: {
        v: 412,
        s: { a: { state: "empty", finding: { code: "upstream-empty", message: "no orders" } } },
      },
      handlers: {},
    });
    const bp = blueprint$({
      id: "empty-bp",
      title: "Empty",
      layout: grid({
        columns: 1,
        children: [
          MetricCard({
            id: "m-empty",
            title: "Latest order",
            binding: { projectionId: "empty-metrics", path: "v", status: { path: "s.a" } },
          }),
        ],
      }),
      projections: ["empty-metrics"],
    });

    render(
      <BlueprintRenderer blueprint={bp} projectionRuntime={runtime} executionId={EXECUTION_ID} />
    );

    const frame = document.querySelector("[data-widget-frame='m-empty']") as HTMLElement;
    expect(frame.getAttribute("data-binding-state")).toBe("empty");
    expect(frame.querySelector("[role='status']")?.textContent).toBe("○ Latest order: no orders");
    expect(frame.textContent).not.toContain("412");
  });

  it("a state this build does not know degrades to loading, never to the error row — how a pre-2.3.0 reader sees `empty` (ADR 0100 D4)", () => {
    // A reader built before 2.3.0 rejects `{ state: "empty" }` in isBindingStatus exactly as this
    // build rejects a state from a later IR: the status resolves to undefined and, with the value
    // cleared as D1 requires, the frame shows the loading row.
    const runtime = new InMemoryProjectionRuntime();
    runtime.register({
      id: "later-metrics",
      initialState: { s: { a: { state: "later" } } },
      handlers: {},
    });
    const bp = blueprint$({
      id: "later-bp",
      title: "Later",
      layout: grid({
        columns: 1,
        children: [
          MetricCard({
            id: "m-later",
            title: "Latest order",
            binding: { projectionId: "later-metrics", path: "v", status: { path: "s.a" } },
          }),
        ],
      }),
      projections: ["later-metrics"],
    });

    render(
      <BlueprintRenderer blueprint={bp} projectionRuntime={runtime} executionId={EXECUTION_ID} />
    );

    const frame = document.querySelector("[data-widget-frame='m-later']") as HTMLElement;
    expect(frame.getAttribute("data-binding-state")).toBe("loading");
    expect(frame.querySelector("[data-binding-marker='loading']")).not.toBeNull();
    expect(frame.querySelector("[role='alert']")).toBeNull();
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

describe("BlueprintRenderer — layout ids keep container identity (IR 2.4.0, ADR 0101)", () => {
  // An uncontrolled field widget: its DOM node IS its state (typed text, focus).
  const registry = new RendererRegistry<WidgetRenderer>().register("Field", ({ widget }) => (
    <input data-testid={widget.id} />
  ));
  const runtime = () => {
    const r = new InMemoryProjectionRuntime();
    r.register({ id: "form", initialState: {}, handlers: {} });
    return r;
  };
  const view = (steps: string[], keyed: boolean): Blueprint =>
    blueprint$({
      id: "form",
      title: "Form",
      layout: stack({
        ...(keyed && { id: "root" }),
        children: steps.map((s) =>
          stack({
            ...(keyed && { id: s }),
            title: s,
            children: [
              customWidget$({
                kind: "Field",
                id: `${s}-field`,
                binding: { projectionId: "form", path: s },
              }),
            ],
          })
        ),
      }),
      projections: ["form"],
    });

  it.each([
    ["eager", false],
    ["fiber", true],
  ])("%s: inserting a step above a typed-in, focused step keeps its <input> node", (_n, fiber) => {
    const rt = runtime();
    const el = (bp: Blueprint) => (
      <BlueprintRenderer
        blueprint={bp}
        projectionRuntime={rt}
        executionId={EXECUTION_ID}
        registry={registry}
        fiber={fiber}
      />
    );
    const { rerender } = render(el(view(["account", "payment"], true)));
    const payment = screen.getByTestId("payment-field") as HTMLInputElement;
    payment.value = "4111 1111";
    payment.focus();

    rerender(el(view(["account", "extra", "payment"], true)));

    expect(screen.getByTestId("payment-field")).toBe(payment);
    expect(payment.value).toBe("4111 1111");
    expect(document.activeElement).toBe(payment);
  });

  it("without layout ids the same insert re-creates the shifted step's <input> (positional, as before)", () => {
    const rt = runtime();
    const el = (bp: Blueprint) => (
      <BlueprintRenderer
        blueprint={bp}
        projectionRuntime={rt}
        executionId={EXECUTION_ID}
        registry={registry}
      />
    );
    const { rerender } = render(el(view(["account", "payment"], false)));
    const payment = screen.getByTestId("payment-field");
    rerender(el(view(["account", "extra", "payment"], false)));
    expect(screen.getByTestId("payment-field")).not.toBe(payment);
  });
});
