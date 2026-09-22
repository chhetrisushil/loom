import {
  type BindingStatus,
  MetricCard,
  RendererRegistry,
  StreamingText,
  asCell,
  blueprint$,
  grid,
} from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { BlueprintRenderer } from "../BlueprintRenderer";
import type { WidgetRenderer } from "../RendererRegistry";

const EXECUTION_ID = "exec-fiber";

// A metrics projection with two independent primitive slices. CPU_UPDATED
// preserves the `mem` sub-object reference (idiomatic immutable update).
type Metrics = { cpu: { current: number }; mem: { current: number } };

function makeRuntime() {
  const runtime = new InMemoryProjectionRuntime();
  runtime.register<Metrics>({
    id: "metrics",
    initialState: { cpu: { current: 10 }, mem: { current: 20 } },
    handlers: {
      CPU_UPDATED: (state, event) => ({
        ...state,
        cpu: { current: (event.payload as { cpu: number }).cpu },
      }),
    },
  });
  return runtime;
}

function cpuEvent(cpu: number, sequence: number) {
  return {
    id: `e${sequence}`,
    workflowId: "wf",
    executionId: EXECUTION_ID,
    eventType: "CPU_UPDATED",
    sequence,
    timestamp: 0,
    payload: { cpu },
  };
}

// Registry whose renderers count how many times each widget id renders.
function spyRegistry(counts: Map<string, number>): RendererRegistry<WidgetRenderer> {
  const reg = new RendererRegistry<WidgetRenderer>();
  const spy: WidgetRenderer = ({ widget, value }) => {
    counts.set(widget.id, (counts.get(widget.id) ?? 0) + 1);
    return (
      <div data-widget-id={widget.id} data-widget-kind={widget.kind}>
        {String(value ?? "—")}
      </div>
    );
  };
  reg.register("MetricCard", spy);
  reg.register("StreamingText", spy);
  return reg;
}

const twoMetrics = blueprint$({
  id: "two-metrics",
  title: "Two Metrics",
  layout: grid({
    columns: 2,
    children: [
      MetricCard({ title: "CPU", binding: { projectionId: "metrics", path: "cpu.current" } }),
      MetricCard({ title: "MEM", binding: { projectionId: "metrics", path: "mem.current" } }),
    ],
  }),
  projections: ["metrics"],
});

// Stable widget ids so render-count assertions can target them. `grid()`
// normalizes every child through `asCell` (IR 2.0.0), so a grid's children are
// GridCell wrappers `{ span, node }`, not bare widgets — unwrap with `asCell`
// rather than reading `.id` off the cell itself.
const cpuId = (asCell(twoMetrics.layout.children[0]).node as { id: string }).id;
const memId = (asCell(twoMetrics.layout.children[1]).node as { id: string }).id;

describe("useFiber — parity", () => {
  it("fiber={false} and fiber={{granularUpdates}} produce identical DOM (initial + after update)", () => {
    const off = makeRuntime();
    const on = makeRuntime();
    const { container: offC } = render(
      <BlueprintRenderer
        blueprint={twoMetrics}
        projectionRuntime={off}
        executionId={EXECUTION_ID}
      />
    );
    const { container: onC } = render(
      <BlueprintRenderer
        blueprint={twoMetrics}
        projectionRuntime={on}
        executionId={EXECUTION_ID}
        fiber={{ granularUpdates: true }}
      />
    );
    expect(onC.innerHTML).toBe(offC.innerHTML);

    act(() => off.handleEvent(cpuEvent(99, 1)));
    act(() => on.handleEvent(cpuEvent(99, 1)));
    expect(onC.innerHTML).toBe(offC.innerHTML);
  });
});

describe("useFiber — granular re-render", () => {
  it("only the widget whose slice changed re-renders (fiber on)", () => {
    const runtime = makeRuntime();
    const counts = new Map<string, number>();
    render(
      <BlueprintRenderer
        blueprint={twoMetrics}
        projectionRuntime={runtime}
        executionId={EXECUTION_ID}
        registry={spyRegistry(counts)}
        fiber={{ granularUpdates: true }}
      />
    );

    expect(counts.get(cpuId)).toBe(1);
    expect(counts.get(memId)).toBe(1);

    act(() => runtime.handleEvent(cpuEvent(55, 1)));

    // CPU slice changed → CPU re-rendered; MEM slice unchanged → NOT re-rendered.
    expect(counts.get(cpuId)).toBe(2);
    expect(counts.get(memId)).toBe(1);
    expect(screen.getByText("55")).not.toBeNull();
  });

  it("off mode re-renders the whole tree on any projection change", () => {
    const runtime = makeRuntime();
    const counts = new Map<string, number>();
    render(
      <BlueprintRenderer
        blueprint={twoMetrics}
        projectionRuntime={runtime}
        executionId={EXECUTION_ID}
        registry={spyRegistry(counts)}
      />
    );
    expect(counts.get(cpuId)).toBe(1);
    expect(counts.get(memId)).toBe(1);

    act(() => runtime.handleEvent(cpuEvent(55, 1)));

    // Whole-tree subscription → both widgets re-render.
    expect(counts.get(cpuId)).toBe(2);
    expect(counts.get(memId)).toBe(2);
  });
});

describe("useFiber — Suspense", () => {
  it("shows a per-widget fallback while a BYOC component suspends, then its content", async () => {
    let resolveIt!: (v: string) => void;
    const promise = new Promise<string>((r) => {
      resolveIt = r;
    });
    let status: "pending" | "done" = "pending";
    let result = "";
    void promise.then((v) => {
      status = "done";
      result = v;
    });

    const reg = new RendererRegistry<WidgetRenderer>();
    reg.register("StreamingText", () => {
      if (status === "pending") throw promise; // classic Suspense contract (React 18)
      return <div data-widget-kind="StreamingText">{result}</div>;
    });

    const bp = blueprint$({
      id: "async-bp",
      title: "Async",
      layout: grid({
        columns: 1,
        children: [
          StreamingText({
            title: "AI",
            binding: { projectionId: "metrics", path: "cpu.current" },
            placeholder: "loading…",
          }),
        ],
      }),
      projections: ["metrics"],
    });

    render(
      <BlueprintRenderer
        blueprint={bp}
        projectionRuntime={makeRuntime()}
        executionId={EXECUTION_ID}
        registry={reg}
        fiber={{ suspense: true }}
      />
    );

    // Fallback = the widget's placeholder.
    expect(screen.getByText("loading…")).not.toBeNull();

    await act(async () => {
      resolveIt("resolved-content");
      await promise;
    });

    expect(screen.getByText("resolved-content")).not.toBeNull();
  });
});

describe("useFiber — deferred streaming", () => {
  it("StreamingText widget renders the latest value through the deferred path", async () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register({
      id: "metrics",
      initialState: { text: "" },
      handlers: {
        TOKEN: (state, event) => ({
          text: `${(state as { text: string }).text}${(event.payload as { t: string }).t}`,
        }),
      },
    });

    const counts = new Map<string, number>();
    const bp = blueprint$({
      id: "stream-bp",
      title: "Stream",
      layout: grid({
        columns: 1,
        children: [
          StreamingText({ title: "AI", binding: { projectionId: "metrics", path: "text" } }),
        ],
      }),
      projections: ["metrics"],
    });

    render(
      <BlueprintRenderer
        blueprint={bp}
        projectionRuntime={runtime}
        executionId={EXECUTION_ID}
        registry={spyRegistry(counts)}
        fiber={{ deferStreaming: true }}
      />
    );

    await act(async () => {
      runtime.handleEvent({
        id: "t1",
        workflowId: "wf",
        executionId: EXECUTION_ID,
        eventType: "TOKEN",
        sequence: 1,
        timestamp: 0,
        payload: { t: "Hel" },
      });
      runtime.handleEvent({
        id: "t2",
        workflowId: "wf",
        executionId: EXECUTION_ID,
        eventType: "TOKEN",
        sequence: 2,
        timestamp: 0,
        payload: { t: "lo" },
      });
    });

    expect(screen.getByText("Hello")).not.toBeNull();
  });
});

// A registry whose renderer counts renders AND records the last status.state
// seen, per widget id — extends spyRegistry to assert on `status`, which fiber
// widgets now subscribe to alongside `value`.
function statusSpyRegistry(
  counts: Map<string, number>,
  statuses: Map<string, BindingStatus["state"] | undefined>
): RendererRegistry<WidgetRenderer> {
  const reg = new RendererRegistry<WidgetRenderer>();
  const spy: WidgetRenderer = ({ widget, value, status }) => {
    counts.set(widget.id, (counts.get(widget.id) ?? 0) + 1);
    statuses.set(widget.id, status?.state);
    return (
      <div data-widget-id={widget.id} data-widget-kind={widget.kind}>
        {String(value ?? "—")}:{status?.state ?? "none"}
      </div>
    );
  };
  reg.register("MetricCard", spy);
  return reg;
}

// Two widgets on the SAME projection, each with its OWN status path, so a
// status-only change to one leaves the other's slice ({ value, status })
// unchanged by every field useWidgetSlice's isEqual compares.
type StatusMetrics = {
  cpu: { current: number };
  mem: { current: number };
  s: { a: { state: string }; b: { state: string } };
};

function makeStatusRuntime() {
  const runtime = new InMemoryProjectionRuntime();
  runtime.register<StatusMetrics>({
    id: "status-metrics",
    initialState: {
      cpu: { current: 10 },
      mem: { current: 20 },
      s: { a: { state: "pending" }, b: { state: "pending" } },
    },
    handlers: {
      // Spreads the PREVIOUS state (not a re-typed subset of it) so the return
      // type matches StatusMetrics exactly, and preserves the `s.b` object
      // reference — the whole point of the "no sibling re-render" assertion.
      STATUS_A_READY: (state) => ({
        ...state,
        s: { ...state.s, a: { state: "ready" } },
      }),
    },
  });
  return runtime;
}

const statusMetrics = blueprint$({
  id: "status-metrics-bp",
  title: "Status Metrics",
  layout: grid({
    columns: 2,
    children: [
      MetricCard({
        id: "wA",
        title: "A",
        binding: { projectionId: "status-metrics", path: "cpu.current", status: { path: "s.a" } },
      }),
      MetricCard({
        id: "wB",
        title: "B",
        binding: { projectionId: "status-metrics", path: "mem.current", status: { path: "s.b" } },
      }),
    ],
  }),
  projections: ["status-metrics"],
});

describe("useFiber — status-only re-render", () => {
  it("changing only a status.state re-renders that widget once and no sibling", () => {
    const runtime = makeStatusRuntime();
    const counts = new Map<string, number>();
    const statuses = new Map<string, BindingStatus["state"] | undefined>();

    render(
      <BlueprintRenderer
        blueprint={statusMetrics}
        projectionRuntime={runtime}
        executionId={EXECUTION_ID}
        registry={statusSpyRegistry(counts, statuses)}
        fiber={{ granularUpdates: true }}
      />
    );

    expect(counts.get("wA")).toBe(1);
    expect(counts.get("wB")).toBe(1);
    expect(statuses.get("wA")).toBe("pending");

    act(() =>
      runtime.handleEvent({
        id: "st1",
        workflowId: "wf",
        executionId: EXECUTION_ID,
        eventType: "STATUS_A_READY",
        sequence: 1,
        timestamp: 0,
        payload: {},
      })
    );

    // The status.state at s.a changed → wA re-rendered (and now passes the new
    // status to its renderer); s.b (and both values) are untouched → wB does
    // NOT re-render.
    expect(counts.get("wA")).toBe(2);
    expect(counts.get("wB")).toBe(1);
    expect(statuses.get("wA")).toBe("ready");
  });
});

// The hook's whole claim, stated negatively: a projection write that touches NO key any widget
// binds must produce zero re-renders. The positive tests above ("only the widget whose slice
// changed re-renders") are satisfied by a subscription that re-renders one widget too many, as
// long as the SIBLING is spared; this one is not.
describe("useFiber — an unrelated projection write re-renders nothing", () => {
  it("writing a key no widget binds leaves every fiber widget's render count untouched", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register<StatusMetrics & { unrelated: number }>({
      id: "status-metrics",
      initialState: {
        cpu: { current: 10 },
        mem: { current: 20 },
        s: { a: { state: "pending" }, b: { state: "pending" } },
        unrelated: 0,
      },
      handlers: {
        // A real state change (a new object, a new value) that no binding and no status path
        // reaches — the projection DOES fire, so the subscription is exercised, not skipped.
        UNRELATED_WRITE: (state) => ({ ...state, unrelated: state.unrelated + 1 }),
      },
    });
    const counts = new Map<string, number>();
    const statuses = new Map<string, BindingStatus["state"] | undefined>();

    render(
      <BlueprintRenderer
        blueprint={statusMetrics}
        projectionRuntime={runtime}
        executionId={EXECUTION_ID}
        registry={statusSpyRegistry(counts, statuses)}
        fiber={{ granularUpdates: true }}
      />
    );
    expect([counts.get("wA"), counts.get("wB")]).toEqual([1, 1]);

    for (let i = 1; i <= 3; i++) {
      act(() =>
        runtime.handleEvent({
          id: `u${i}`,
          workflowId: "wf",
          executionId: EXECUTION_ID,
          eventType: "UNRELATED_WRITE",
          sequence: i,
          timestamp: 0,
          payload: {},
        })
      );
    }

    expect(runtime.getState("status-metrics", EXECUTION_ID)).toMatchObject({ unrelated: 3 });
    expect([counts.get("wA"), counts.get("wB")]).toEqual([1, 1]);
  });
});
