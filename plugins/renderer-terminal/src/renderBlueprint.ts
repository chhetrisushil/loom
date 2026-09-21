import type { Blueprint, Layout, RendererRegistry, Widget } from "@loom/blueprint-runtime";
import { traverseBlueprint } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import type { TerminalWidgetRenderer } from "./defaultRegistry";
import { formatValue, indent } from "./format";

export interface TerminalRenderOptions {
  /**
   * Kind-aware renderers. Absent → the kind-blind `title: value` output (unchanged since the
   * plugin shipped). Present → a registered kind renders through its renderer, and a kind the
   * registry LACKS is prefixed `[kind]` so the gap is visible on the surface rather than
   * flattened away. `defaultTerminalRegistry` covers loom's eight built-ins.
   */
  registry?: RendererRegistry<TerminalWidgetRenderer>;
}

// The kind-blind rendering: `title: value`, multi-line values indented under the title.
function renderKindBlind(widget: Widget, value: unknown): string {
  const title = widget.title ?? widget.kind;
  const rendered = formatValue(value);
  return rendered.includes("\n")
    ? `${title}:\n${indent(rendered, "    ")}`
    : `${title}: ${rendered}`;
}

// Renders a blueprint to plain text using the framework-agnostic traverseBlueprint<string>
// walker — the same tree, a different surface.
//
// Without a registry this renderer is KIND-BLIND: it flattens every widget to `title: value`.
// That is legitimate for a text surface, but it cannot fail on an unknown kind because it never
// looks, so it degrades SILENTLY. With a registry it looks: a registered kind renders through its
// renderer and an unregistered one is MARKED. `defaultTerminalRegistry` covers the built-in
// catalogue, and `catalogCoverage` is how a caller proves theirs does (ADR 0088, ADR 0096).
export function renderBlueprintToString(
  blueprint: Blueprint,
  stateMap: Map<string, unknown>,
  options: TerminalRenderOptions = {}
): string {
  const registry = options.registry;
  const body = traverseBlueprint<string>(blueprint.layout, stateMap, {
    renderWidget({ widget, value }: { widget: Widget; value: unknown }) {
      if (registry === undefined) return renderKindBlind(widget, value);
      const renderer = registry.get(widget.kind);
      if (renderer === undefined) return `[${widget.kind}] ${renderKindBlind(widget, value)}`;
      return renderer(widget, value);
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
  constructor(
    private readonly projectionRuntime: ProjectionRuntime,
    private readonly options: TerminalRenderOptions = {}
  ) {}

  render(blueprint: Blueprint, executionId: string): string {
    const stateMap = new Map<string, unknown>();
    for (const projectionId of blueprint.projections) {
      stateMap.set(projectionId, this.projectionRuntime.getState(projectionId, executionId));
    }
    return renderBlueprintToString(blueprint, stateMap, this.options);
  }
}
