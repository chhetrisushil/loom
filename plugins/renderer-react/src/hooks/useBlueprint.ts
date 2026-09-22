import type { Blueprint, GridCell, Layout, Widget } from "@loom/blueprint-runtime";
import { asCell, resolveWidgetValue } from "@loom/blueprint-runtime";
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
  if (layout.type === "grid") {
    // A grid's children are GridCell wrappers (IR 2.0.0) or bare Widget/Layout
    // nodes (a legacy 1.0.0 artifact) — asCell normalizes either into a cell
    // and this walks its `node`, same as traverseBlueprint does.
    return layout.children.flatMap((child) =>
      collectWidgets(asCell(child as GridCell | Widget | Layout).node)
    );
  }
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
