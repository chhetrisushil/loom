import type { Blueprint, Widget } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { useProjection } from "./useProjection";

export interface ResolvedWidget {
  widget: Widget;
  value: unknown;
}

function getNestedValue(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function collectWidgets(node: Blueprint["layout"] | Widget): Widget[] {
  if ("_tag" in node && node._tag === "Widget") {
    return [node as Widget];
  }
  const layout = node as Blueprint["layout"];
  return layout.children.flatMap((child) => collectWidgets(child as Blueprint["layout"] | Widget));
}

export function useBlueprintProjectionValues(
  blueprint: Blueprint,
  projectionRuntime: ProjectionRuntime,
  executionId: string
): Map<string, unknown> {
  const stateMap = new Map<string, unknown>();
  for (const projectionId of blueprint.projections) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const state = useProjection(projectionRuntime, projectionId, executionId);
    stateMap.set(projectionId, state);
  }
  return stateMap;
}

export function resolveWidget(widget: Widget, stateMap: Map<string, unknown>): unknown {
  if (!widget.binding) return undefined;
  const projectionState = stateMap.get(widget.binding.projectionId);
  return getNestedValue(projectionState, widget.binding.path);
}

export function collectAllWidgets(blueprint: Blueprint): Widget[] {
  return collectWidgets(blueprint.layout);
}
