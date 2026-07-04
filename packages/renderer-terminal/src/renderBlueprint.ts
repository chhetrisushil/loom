import type { Blueprint, Layout, Widget } from "@loom/blueprint-runtime";
import { traverseBlueprint } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    return value
      .map((item) =>
        typeof item === "object" && item !== null
          ? `• ${Object.values(item as Record<string, unknown>).map(String).join(" · ")}`
          : `• ${String(item)}`
      )
      .join("\n");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Renders a blueprint to plain text using the framework-agnostic
// traverseBlueprint<string> walker — the same tree, a different surface. This
// demonstrates the proposal's multi-surface delivery: web (React), terminal,
// and any other target share one blueprint and one projection state map.
export function renderBlueprintToString(
  blueprint: Blueprint,
  stateMap: Map<string, unknown>
): string {
  const body = traverseBlueprint<string>(blueprint.layout, stateMap, {
    renderWidget({ widget, value }: { widget: Widget; value: unknown }) {
      const title = widget.title ?? widget.kind;
      const rendered = formatValue(value);
      return rendered.includes("\n")
        ? `${title}:\n${indent(rendered, "    ")}`
        : `${title}: ${rendered}`;
    },
    renderContainer({ children }: { layout: Layout; children: string[] }) {
      return children.filter((c) => c.length > 0).join("\n");
    },
  });

  const bar = "═".repeat(Math.max(blueprint.title.length + 2, 24));
  return `${bar}\n  ${blueprint.title}\n${bar}\n${body}\n`;
}

// Convenience wrapper that pulls each of a blueprint's projections from a
// ProjectionRuntime for a given execution, then renders to text.
export class TerminalRenderer {
  constructor(private readonly projectionRuntime: ProjectionRuntime) {}

  render(blueprint: Blueprint, executionId: string): string {
    const stateMap = new Map<string, unknown>();
    for (const projectionId of blueprint.projections) {
      stateMap.set(projectionId, this.projectionRuntime.getState(projectionId, executionId));
    }
    return renderBlueprintToString(blueprint, stateMap);
  }
}
