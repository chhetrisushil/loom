import type { Blueprint, Layout, Widget } from "@loom/blueprint-runtime";
import { traverseBlueprint } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { formatValue, indent } from "./format";

// Renders a blueprint to plain text using the framework-agnostic
// traverseBlueprint<string> walker — the same tree, a different surface. This
// demonstrates the proposal's multi-surface delivery: web (React), terminal,
// and any other target share one blueprint and one projection state map.
//
// This renderer is deliberately KIND-BLIND: it never reads `widget.kind`, and
// flattens every widget to `title: value`. That is legitimate for a text surface
// — a terminal cannot draw a progress bar — but it has a consequence worth
// stating rather than leaving implied. It cannot fail on an unknown kind, because
// it never looks; where the React renderer degrades visibly (a placeholder for a
// kind it cannot render, caught ahead of time by `catalogCoverage`), this one
// degrades SILENTLY, by dropping the semantics.
//
// So "two people looking at one blueprint see the same thing" holds for the data
// and not for the presentation. Anything that depends on cross-surface agreement
// — a shared incident view, two responders on a call — needs a renderer that
// covers the catalogue (ADR 0088), which this one does not claim to.
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
