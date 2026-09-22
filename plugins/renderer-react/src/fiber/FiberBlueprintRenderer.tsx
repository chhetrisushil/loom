import type { Blueprint, RendererRegistry } from "@loom/blueprint-runtime";
import { traverseBlueprint } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import type React from "react";
import type { WidgetAction, WidgetRenderer } from "../RendererRegistry";
import { defaultRegistry } from "../RendererRegistry";
import type { WidgetValueCheck } from "../WidgetFrame";
import { renderReactContainer } from "../renderContainer";
import { mountFiberWidget } from "./FiberWidget";
import type { ResolvedFiberConfig } from "./types";

interface FiberBlueprintRendererProps {
  blueprint: Blueprint;
  projectionRuntime: ProjectionRuntime;
  executionId: string;
  registry?: RendererRegistry<WidgetRenderer>;
  onAction?: (action: WidgetAction) => void;
  /** See BlueprintRendererProps.check — the same slot, on the fiber path. */
  check?: WidgetValueCheck;
  config: ResolvedFiberConfig;
}

// Structure is state-independent, so we traverse with a single shared empty map.
const EMPTY_STATE = new Map<string, unknown>();

// Fiber-mode render: walk the blueprint ONCE to build the (stable) container
// structure with a self-subscribing <FiberWidget> at each leaf. This component
// subscribes to NO projections, so it does not re-render on projection events —
// only the individual widget whose slice changed re-renders.
export function FiberBlueprintRenderer({
  blueprint,
  projectionRuntime,
  executionId,
  registry,
  onAction,
  check,
  config,
}: FiberBlueprintRendererProps): React.ReactElement {
  const reg = registry ?? defaultRegistry;

  const root = traverseBlueprint<React.ReactNode>(blueprint.layout, EMPTY_STATE, {
    renderWidget({ widget }) {
      return mountFiberWidget(config, {
        widget,
        runtime: projectionRuntime,
        executionId,
        registry: reg,
        ...(onAction !== undefined && { onAction }),
        ...(check !== undefined && { check }),
      });
    },
    renderContainer({ layout, children, cells }) {
      return renderReactContainer(layout, children, cells);
    },
  });

  return (
    <div data-blueprint-id={blueprint.id}>
      <h1>{blueprint.title}</h1>
      {root}
    </div>
  );
}
