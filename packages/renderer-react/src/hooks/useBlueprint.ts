import type { Blueprint, Widget } from "@loom/blueprint-runtime";
import { resolveWidgetValue } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { useProjection } from "./useProjection";

export interface ResolvedWidget {
  widget: Widget;
  value: unknown;
}

// Re-exported from @loom/blueprint-runtime for backwards compat.
export { resolveWidgetValue as resolveWidget };

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

export function collectAllWidgets(blueprint: Blueprint): Widget[] {
  return collectWidgets(blueprint.layout);
}
