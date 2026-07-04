import React from "react";
import type { Blueprint, Layout, Widget } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { type WidgetAction, defaultRegistry } from "./RendererRegistry";
import { collectAllWidgets, resolveWidget, useBlueprintProjectionValues } from "./hooks/useBlueprint";

interface BlueprintRendererProps {
  blueprint: Blueprint;
  projectionRuntime: ProjectionRuntime;
  executionId: string;
  onAction?: (action: WidgetAction) => void;
}

function WidgetNode({
  widget,
  stateMap,
  onAction,
}: {
  widget: Widget;
  stateMap: Map<string, unknown>;
  onAction?: (action: WidgetAction) => void;
}) {
  const Renderer = defaultRegistry.get(widget.kind);
  const value = resolveWidget(widget, stateMap);

  if (!Renderer) {
    return (
      <div data-widget-id={widget.id} data-widget-kind={widget.kind}>
        {`[No renderer for ${widget.kind}]`}
      </div>
    );
  }

  return <Renderer widget={widget} value={value} {...(onAction && { onAction })} />;
}

function LayoutNode({
  layout,
  stateMap,
  onAction,
}: {
  layout: Layout | Widget;
  stateMap: Map<string, unknown>;
  onAction?: (action: WidgetAction) => void;
}) {
  if ("_tag" in layout && layout._tag === "Widget") {
    return (
      <WidgetNode
        widget={layout as Widget}
        stateMap={stateMap}
        {...(onAction && { onAction })}
      />
    );
  }

  const l = layout as Layout;

  const childNodes = l.children.map((child, i) => (
    <LayoutNode
      key={i}
      layout={child as Layout | Widget}
      stateMap={stateMap}
      {...(onAction && { onAction })}
    />
  ));

  if (l.type === "grid") {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${l.columns}, 1fr)`,
          ...(l.gap !== undefined && { gap: `${l.gap}px` }),
        }}
      >
        {childNodes}
      </div>
    );
  }

  if (l.type === "flex") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: l.direction,
          ...(l.gap !== undefined && { gap: `${l.gap}px` }),
        }}
      >
        {childNodes}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        ...(l.gap !== undefined && { gap: `${l.gap}px` }),
      }}
    >
      {childNodes}
    </div>
  );
}

export function BlueprintRenderer({
  blueprint,
  projectionRuntime,
  executionId,
  onAction,
}: BlueprintRendererProps) {
  const stateMap = useBlueprintProjectionValues(blueprint, projectionRuntime, executionId);

  return (
    <div data-blueprint-id={blueprint.id}>
      <h1>{blueprint.title}</h1>
      <LayoutNode
        layout={blueprint.layout}
        stateMap={stateMap}
        {...(onAction && { onAction })}
      />
    </div>
  );
}
