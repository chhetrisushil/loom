import type {
  BindingStatus,
  Blueprint,
  ContainerContext,
  RendererRegistry,
  Widget,
  WidgetValueCheck,
} from "@loom/blueprint-runtime";
import {
  describeWidgetFrame,
  describeWidgetStatus,
  traverseBlueprint,
} from "@loom/blueprint-runtime";
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
export type { WidgetValueCheck };

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

type Cells = NonNullable<ContainerContext<string>["cells"]>;

const isPlaced = (c: Cells[number]): boolean =>
  c.row !== undefined || c.rowSpan !== undefined || c.column !== undefined;

// A text surface has one column, so honouring placement (IR 2.1.0, ADR 0098) means READING
// order: row, then column. An absent coordinate sorts after every present one, and the sort is
// stable, so ties keep document order. Only called when a cell is placed — an unplaced grid
// keeps document order and its output is byte-identical to 2.0.0.
function readingOrder(cells: Cells): string[] {
  const at = (v: number | undefined) => (v === undefined ? Number.POSITIVE_INFINITY : v);
  // When BOTH sides are absent on an axis, `Infinity - Infinity` is NaN — falsy in `||` — so the
  // comparator falls through to the next key instead of reporting a (wrong) tie-breaking order.
  return cells
    .map((c, i) => ({ c, i }))
    .sort((x, y) => at(x.c.row) - at(y.c.row) || at(x.c.column) - at(y.c.column) || x.i - y.i)
    .map(({ c }) => c.child);
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
      // The decision is shared (`describeWidgetStatus`); this renderer owns only the text.
      const d = describeWidgetStatus(widget, value, status, check);
      // A malformed `source` is the error placeholder (as DOM and React), never a throw.
      if (d.tag === "invalid") return `[Renderer for ${widget.kind} failed]`;
      // IR 2.5.0: withheld for the surface's audience — a constant marker, no title, no value.
      const m = describeWidgetFrame(widget, d).marker;
      if (d.tag === "redacted") return m?.text ?? "";
      let text: string;
      if (d.tag === "inert") text = inner();
      else if (d.tag === "error" || d.tag === "empty") text = m?.text ?? "";
      else if (d.tag === "stale")
        text = d.hasValue ? `${m?.glyph} ${inner()}` : `${m?.glyph} ${title}: — (${d.message})`;
      else if (d.tag === "pending") text = `${m?.glyph} ${inner()}`;
      // `loading`: the same glyph React and loom-ui's Lit base use (ADR 0097 D2).
      else if (d.tag === "loading") text = `⋯ ${title}`;
      else text = inner();
      if (d.degradedChain) {
        const [first, ...rest] = text.split("\n");
        text = [`${first} (degraded from ${d.degradedChain})`, ...rest].join("\n");
      }
      return text;
    },
    renderContainer({ layout, children, cells }: ContainerContext<string>) {
      // `layout.role` (IR 2.2.0, ADR 0099) is ignored on purpose: a role is an interaction hint,
      // and every child under the title, in reading order, is already the whole content.
      // `layout.id` (IR 2.4.0, ADR 0101) is ignored too: a one-shot string has nothing to
      // reconcile, so a container's identity cannot change a byte of it.
      const ordered = cells?.some(isPlaced) ? readingOrder(cells) : children;
      const body = ordered.filter((c) => c.length > 0).join("\n");
      const title = typeof layout.title === "string" && layout.title !== "" ? layout.title : "";
      if (title === "") return body;
      const heading = `${title}\n${"─".repeat(title.length)}`;
      return body.length > 0 ? `${heading}\n${body}` : heading;
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
