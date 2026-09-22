import type {
  BindingStatus,
  Blueprint,
  Layout,
  RendererRegistry,
  Widget,
} from "@loom/blueprint-runtime";
import { traverseBlueprint } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import type { TerminalWidgetRenderer } from "./defaultRegistry";
import { formatValue, indent } from "./format";

/**
 * A caller-supplied value-contract check — the documented slot the canonical status matrix
 * leaves between `error` and `stale` (design §5). loom validates nothing about a bound VALUE
 * itself: what a `Trend` or an `Investigation` must look like is a framework's catalogue
 * vocabulary, not the IR's. A framework plugs its own `checkKindValue` in here and a failure
 * renders as the error row, outranking `stale`, `pending` and `ready` — the value is wrong, so
 * showing it (or a staleness marker about it) would be worse than saying so.
 *
 * Returning `undefined` means "nothing to say"; the normal matrix then applies.
 */
export type WidgetValueCheck = (
  widget: Widget,
  value: unknown
) => { code: string; message: string } | undefined;

export interface TerminalRenderOptions {
  /**
   * Kind-aware renderers. Absent → the kind-blind `title: value` output (unchanged since the
   * plugin shipped). Present → a registered kind renders through its renderer, and a kind the
   * registry LACKS is prefixed `[kind]` so the gap is visible on the surface rather than
   * flattened away. `defaultTerminalRegistry` covers loom's eight built-ins.
   */
  registry?: RendererRegistry<TerminalWidgetRenderer>;
  /**
   * Value-contract check, run between `error` and `stale` in the canonical matrix, and ONLY for
   * a widget whose binding declares a status channel (a widget with no channel renders exactly
   * as it did under IR 1.0.0, which is a property this option must not break). A delivery
   * `error` already outranks it — there is no value to check when the fetch itself failed.
   */
  check?: WidgetValueCheck;
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
  const check = options.check;
  const body = traverseBlueprint<string>(blueprint.layout, stateMap, {
    renderWidget({
      widget,
      value,
      status,
    }: {
      widget: Widget;
      value: unknown;
      status?: BindingStatus;
    }) {
      // One registry lookup, not two: `get` is a caller-supplied registry's method, so calling
      // it twice per widget is both wasted work and an assumption that it is pure.
      const renderer = registry?.get(widget.kind);
      const inner = (): string =>
        registry === undefined
          ? renderKindBlind(widget, value)
          : renderer
            ? renderer(widget, value, status)
            : `[${widget.kind}] ${renderKindBlind(widget, value)}`;
      const title = widget.title ?? widget.kind;
      const channel = widget.binding?.status !== undefined;
      // The §5 slot: between `error` and `stale`, and only for a declared channel.
      const contract = channel && status?.state !== "error" ? check?.(widget, value) : undefined;
      let text: string;
      if (!channel) text = inner();
      else if (status?.state === "error")
        text = `✗ ${title}: ${status.finding?.message ?? "error"}`;
      else if (contract) text = `✗ ${title}: ${contract.message}`;
      else if (status?.state === "stale")
        text =
          value === undefined
            ? `~ ${title}: — (${status.finding?.message ?? "stale"})`
            : `~ ${inner()}`;
      else if (status?.state === "pending")
        text = value === undefined ? `⋯ ${title}` : `⋯ ${inner()}`;
      // `ready`, or a status that has not landed yet / is malformed. A PRESENT value renders
      // ready; an ABSENT one is the loading row, and the terminal now says so with the same
      // glyph React and loom-ui's Lit base use rather than printing `title: —`, which reads as
      // "the answer is nothing" instead of "it has not arrived". ADR 0097 D2 calls the matrix
      // identical on every renderer; this row was the one that was not.
      else text = value === undefined ? `⋯ ${title}` : inner();
      const chain = widget.source?.degradedFrom?.map((d) => `${d.type}@${d.version}`).join(" › ");
      if (chain) {
        const [first, ...rest] = text.split("\n");
        text = [`${first} (degraded from ${chain})`, ...rest].join("\n");
      }
      return text;
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
