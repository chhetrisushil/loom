import { ApprovalCard, MetricCard, Timeline, blueprint$, grid } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { render, screen, act } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintRenderer } from "./BlueprintRenderer";
import {
  ApprovalCardRenderer,
  MetricCardRenderer,
  TimelineRenderer,
} from "./renderers";
import { defaultRegistry } from "./RendererRegistry";

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
      MetricCard({ title: "CPU Usage %", binding: { projectionId: "metrics", path: "cpu.current" } }),
      Timeline({ title: "Event Timeline", binding: { projectionId: "incident", path: "timeline" } }),
      ApprovalCard({ title: "Approve Fix", binding: { projectionId: "incident", path: "pendingApproval" } }),
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
            kind: "DataTable" as const,
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

    expect(screen.getByText("[No renderer for DataTable]")).not.toBeNull();
  });
});
