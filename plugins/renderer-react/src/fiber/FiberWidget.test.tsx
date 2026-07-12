import {
  MetricCard,
  RendererRegistry,
  StreamingText,
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

// Stable widget ids so render-count assertions can target them.
const cpuId = (twoMetrics.layout.children[0] as { id: string }).id;
const memId = (twoMetrics.layout.children[1] as { id: string }).id;

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
