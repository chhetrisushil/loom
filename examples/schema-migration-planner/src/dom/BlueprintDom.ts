import type { Blueprint, Layout, WidgetAction } from "@loom/blueprint-runtime";
import { resolveWidgetValue, traverseBlueprint } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { KIND_TO_TAG, type WidgetHost } from "./elements";

// ── BlueprintDom — the framework-agnostic BYOR core, for the DOM ──────────────
//
// Walks a Loom blueprint once with traverseBlueprint<HTMLElement>, mounting one
// Custom Element per widget and one container <div> per layout node. Each widget
// subscribes to ONLY its bound projection slice and updates just its own
// `.value` when that slice changes — so a projection event re-renders one widget
// (e.g. a single task row), never the whole tree. That is the same granular,
// near-real-time model React's fiber renderer provides, implemented on the
// platform. Widget actions bubble up as `widget-action` CustomEvents.

export interface MountedBlueprint {
  element: HTMLElement;
  dispose(): void;
}

const EMPTY = new Map<string, unknown>();

function applyContainerStyle(div: HTMLElement, layout: Layout): void {
  const gap =
    layout.type === "grid" || layout.type === "flex" || layout.type === "stack"
      ? layout.gap
      : undefined;
  if (gap !== undefined) div.style.gap = `${gap}px`;
  if (layout.type === "grid") {
    div.className = "container-grid";
    div.style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`;
  } else if (layout.type === "flex") {
    div.className = "container-flex";
    div.style.flexDirection = layout.direction;
  } else {
    div.className = "container-stack";
  }
}

export function mountBlueprint(
  blueprint: Blueprint,
  runtime: ProjectionRuntime,
  executionId: string,
  onAction?: (action: WidgetAction) => void
): MountedBlueprint {
  const unsubs: Array<() => void> = [];

  const tree = traverseBlueprint<HTMLElement>(blueprint.layout, EMPTY, {
    renderWidget({ widget }) {
      const tag = KIND_TO_TAG[widget.kind];
      if (!tag) {
        const fallback = document.createElement("div");
        fallback.textContent = `[No renderer for ${widget.kind}]`;
        return fallback;
      }
      const node = document.createElement(tag);
      const host = node as unknown as WidgetHost;
      host.setWidget(widget);

      const projectionId = widget.binding?.projectionId;
      const update = (): void => {
        const map = new Map<string, unknown>();
        if (projectionId) map.set(projectionId, runtime.getState(projectionId, executionId));
        host.value = resolveWidgetValue(widget, map);
      };
      update();
      if (projectionId) {
        unsubs.push(runtime.subscribe(projectionId, executionId, () => update()));
      }
      return node;
    },
    renderContainer({ layout, children }) {
      const div = document.createElement("div");
      applyContainerStyle(div, layout);
      for (const child of children) div.appendChild(child);
      return div;
    },
  });

  const wrapper = document.createElement("div");
  wrapper.className = "bp";
  const h1 = document.createElement("h1");
  h1.textContent = blueprint.title;
  wrapper.append(h1, tree);

  if (onAction) {
    wrapper.addEventListener("widget-action", (e) => {
      onAction((e as CustomEvent<WidgetAction>).detail);
    });
  }

  return {
    element: wrapper,
    dispose(): void {
      for (const u of unsubs) u();
    },
  };
}
