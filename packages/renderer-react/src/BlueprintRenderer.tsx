import React from "react";
import type { Blueprint } from "@loom/blueprint-runtime";
import { traverseBlueprint } from "@loom/blueprint-runtime";
import type { RendererRegistry } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import type { WidgetAction, WidgetRenderer } from "./RendererRegistry";
import { defaultRegistry } from "./RendererRegistry";
import { useBlueprintProjectionValues } from "./hooks/useBlueprint";

interface BlueprintRendererProps {
  blueprint: Blueprint;
  projectionRuntime: ProjectionRuntime;
  executionId: string;
  registry?: RendererRegistry<WidgetRenderer>;
  onAction?: (action: WidgetAction) => void;
}

export function BlueprintRenderer({
  blueprint,
  projectionRuntime,
  executionId,
  registry,
  onAction,
}: BlueprintRendererProps) {
  const stateMap = useBlueprintProjectionValues(blueprint, projectionRuntime, executionId);
  const reg = registry ?? defaultRegistry;

  const root = traverseBlueprint<React.ReactNode>(blueprint.layout, stateMap, {
    renderWidget({ widget, value, onAction: act }) {
      const Renderer = reg.get(widget.kind);
      if (!Renderer) {
        return (
          <div key={widget.id} data-widget-id={widget.id} data-widget-kind={widget.kind}>
            {`[No renderer for ${widget.kind}]`}
          </div>
        );
      }
      return (
        <Renderer
          key={widget.id}
          widget={widget}
          value={value}
          {...(act !== undefined && { onAction: act })}
        />
      );
    },
    renderContainer({ layout, children }) {
      if (layout.type === "grid") {
        return (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
              ...(layout.gap !== undefined && { gap: `${layout.gap}px` }),
            }}
          >
            {children}
          </div>
        );
      }
      if (layout.type === "flex") {
        return (
          <div
            style={{
              display: "flex",
              flexDirection: layout.direction,
              ...(layout.gap !== undefined && { gap: `${layout.gap}px` }),
            }}
          >
            {children}
          </div>
        );
      }
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            ...(layout.gap !== undefined && { gap: `${layout.gap}px` }),
          }}
        >
          {children}
        </div>
      );
    },
    ...(onAction !== undefined && { onAction }),
  });

  return (
    <div data-blueprint-id={blueprint.id}>
      <h1>{blueprint.title}</h1>
      {root}
    </div>
  );
}
