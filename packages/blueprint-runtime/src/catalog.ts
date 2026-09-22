import { asCell } from "./normalize";
import type { Blueprint, GridCell, Layout, Widget } from "./types";

// ── The component catalogue, and the check that it is honoured ────────────────
//
// A blueprint that a *person* wrote is checked by the type system: the widget
// builders are functions, and a typo is a compile error. A blueprint that a
// *model* composed at runtime has no such check — it is data, assembled from a
// catalogue, and the only thing standing between an off-catalogue component and
// a viewer is whatever validates it on the way out.
//
// Nothing did. `Widget.kind` is widened to `string` so custom renderers can
// register any kind, and an unregistered kind reaches the renderer, which prints
// a placeholder — per viewer, at render time, once the surface is already open.
//
// This module is the missing check. Two properties, and they are different:
//
//   1. every `kind` is one the catalogue defines — the *closure* property. A
//      composer may only assemble from an audited set, so accessibility, i18n
//      and design conformance are verified once per component and inherited by
//      every composition;
//   2. every widget carries a `DataBinding` and no unbound payload in `props` —
//      the *exfiltration* property. A blueprint declares what to fetch, never
//      what was fetched, which is what lets one blueprint be shared and then
//      hydrated separately against each viewer's own permissions. A composer
//      that inlines a fetched row into `props` silently turns a shareable
//      artifact into a copy of one viewer's data.
//
// `validateBlueprint` never throws. A missing component is a *finding* — the
// caller decides whether to degrade to a plainer widget, refuse, or record a
// catalogue gap — and a rate can be computed over findings, which is the point:
// "how often does a composer get this right on the first attempt" is not a
// question an exception can answer.

/**
 * One component a composer may name.
 *
 * Both fields are required. An optional allow-list is the failure mode this
 * module exists to prevent: an entry that declined to say which props it accepts
 * would pass the payload check vacuously, and a check that cannot fail reads as
 * coverage while verifying nothing. `props: []` is a perfectly good answer.
 */
export interface CatalogEntry {
  readonly kind: string;
  /**
   * Prop keys this component accepts. `binding` is reserved and always allowed —
   * the built-in builders duplicate the declared binding into `props` — so it
   * need not be listed.
   */
  readonly props: readonly string[];
  /**
   * Whether this component renders bound data.
   * - `required` — a widget without a `DataBinding` renders nothing, so its
   *   absence is an error rather than an empty state;
   * - `optional` — either is legitimate;
   * - `none` — decorative or structural; a binding on it is a composer mistake.
   */
  readonly binding: "required" | "optional" | "none";
}

export interface WidgetCatalog {
  readonly id: string;
  readonly entries: readonly CatalogEntry[];
}

/** Identity helper — declare a catalogue with inferred types. */
export function defineWidgetCatalog(catalog: WidgetCatalog): WidgetCatalog {
  return catalog;
}

export const BUILTIN_CATALOG_ID = "loom.builtin.v1";

/**
 * The eight widgets `@loom/blueprint-runtime` ships, as a catalogue.
 *
 * `props` mirrors each builder's props interface minus `title` (hoisted onto
 * `Widget.title`) and minus `binding` (reserved). Every built-in requires a
 * binding — none of them render anything without one.
 */
export const builtinCatalog: WidgetCatalog = {
  id: BUILTIN_CATALOG_ID,
  entries: [
    { kind: "MetricCard", props: ["unit", "format"], binding: "required" },
    { kind: "Timeline", props: ["maxItems"], binding: "required" },
    { kind: "ApprovalCard", props: ["approveLabel", "rejectLabel"], binding: "required" },
    { kind: "StatusBadge", props: [], binding: "required" },
    { kind: "ProgressBar", props: ["max"], binding: "required" },
    { kind: "DataTable", props: ["columns"], binding: "required" },
    { kind: "AlertCard", props: ["severity"], binding: "required" },
    { kind: "StreamingText", props: ["placeholder"], binding: "required" },
  ],
};

// ── Findings ──────────────────────────────────────────────────────────────────

export type BlueprintFindingCode =
  /** A `kind` the catalogue does not define. */
  | "unknown-kind"
  /** A `binding: "required"` component with no `DataBinding`. */
  | "missing-binding"
  /** A `binding: "none"` component carrying one anyway. */
  | "unexpected-binding"
  /** A prop key outside the catalogue entry's allow-list — the exfiltration check. */
  | "undeclared-prop"
  /** A binding to a projection the blueprint never declares — renders blank, silently. */
  | "undeclared-projection"
  /** Two widgets sharing an id — node identity, and the renderer's key, collide. */
  | "duplicate-node-id";

export interface BlueprintFinding {
  readonly code: BlueprintFindingCode;
  readonly severity: "error" | "warn";
  readonly message: string;
  /** The widget the finding applies to. */
  readonly nodeId: string;
  readonly kind: string;
}

export interface BlueprintValidation {
  /** True iff there are no `error`-severity findings. */
  readonly ok: boolean;
  readonly findings: readonly BlueprintFinding[];
  /**
   * Widgets visited. The denominator for a first-attempt validation rate — a
   * report with zero widgets is not a pass, and this is how a caller tells the
   * difference.
   */
  readonly widgets: number;
}

/** Duplicated into `props` by every built-in builder; never a payload. */
const RESERVED_PROPS = new Set(["binding"]);

/** Iterative pre-order walk — an explicit stack, so a deep tree cannot blow the call stack. */
function eachWidget(root: Layout | Widget, visit: (widget: Widget) => void): void {
  const stack: Array<Layout | Widget> = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if ("_tag" in node && node._tag === "Widget") {
      visit(node as Widget);
      continue;
    }
    const layout = node as Layout;
    for (let i = layout.children.length - 1; i >= 0; i--) {
      stack.push(
        layout.type === "grid"
          ? asCell(layout.children[i] as GridCell).node
          : (layout.children[i] as Layout | Widget)
      );
    }
  }
}

/**
 * Check a blueprint against a catalogue. Never throws; returns every finding it
 * can see in one pass, so a caller degrades or records a gap on the whole report
 * rather than on the first failure.
 */
export function validateBlueprint(
  blueprint: Blueprint,
  catalog: WidgetCatalog
): BlueprintValidation {
  const entries = new Map<string, CatalogEntry>();
  for (const entry of catalog.entries) entries.set(entry.kind, entry);
  const projections = new Set(blueprint.projections);

  const findings: BlueprintFinding[] = [];
  const seenIds = new Set<string>();
  let widgets = 0;

  eachWidget(blueprint.layout, (widget) => {
    widgets++;
    const { id, kind } = widget;

    if (seenIds.has(id)) {
      findings.push({
        code: "duplicate-node-id",
        severity: "error",
        nodeId: id,
        kind,
        message: `two widgets share the id "${id}" — node identity and the renderer's key collide, so one silently replaces the other`,
      });
    }
    seenIds.add(id);

    const entry = entries.get(kind);
    if (!entry) {
      findings.push({
        code: "unknown-kind",
        severity: "error",
        nodeId: id,
        kind,
        message: `"${kind}" is not in catalogue "${catalog.id}" — a composer may only assemble from the audited set`,
      });
      // Nothing further is checkable without an entry: the allow-list and the
      // binding requirement both come from it. Reporting invented follow-on
      // findings here would inflate the count for one real defect.
      return;
    }

    if (entry.binding === "required" && !widget.binding) {
      findings.push({
        code: "missing-binding",
        severity: "error",
        nodeId: id,
        kind,
        message: `"${kind}" renders bound data but carries no binding — it would render blank with no error`,
      });
    }
    if (entry.binding === "none" && widget.binding) {
      findings.push({
        code: "unexpected-binding",
        severity: "warn",
        nodeId: id,
        kind,
        message: `"${kind}" is declared as taking no binding, but this widget carries one`,
      });
    }

    if (widget.binding && !projections.has(widget.binding.projectionId)) {
      findings.push({
        code: "undeclared-projection",
        severity: "error",
        nodeId: id,
        kind,
        message: `binds to projection "${widget.binding.projectionId}", which the blueprint does not declare — renderers hydrate only declared projections, so this widget resolves to undefined and renders blank`,
      });
    }

    const allowed = new Set(entry.props);
    for (const prop of Object.keys(widget.props)) {
      if (RESERVED_PROPS.has(prop) || allowed.has(prop)) continue;
      findings.push({
        code: "undeclared-prop",
        severity: "error",
        nodeId: id,
        kind,
        message: `prop "${prop}" is not declared by "${kind}" in catalogue "${catalog.id}" — a blueprint carries bindings, never fetched data, and an undeclared prop is how data gets inlined into a shared artifact`,
      });
    }
  });

  return {
    ok: findings.every((f) => f.severity !== "error"),
    findings,
    widgets,
  };
}
