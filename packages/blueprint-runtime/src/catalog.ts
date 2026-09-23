import { hasLayoutId, isLayoutRole } from "./layout";
import { IR_VERSIONS_READ_AS_IS, IR_VERSION_LEGACY, asCell, isWidget } from "./normalize";
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
  /**
   * Two nodes sharing an id — node identity, and the renderer's key, collide. Widget ids and
   * layout ids (IR 2.4.0) are ONE namespace: widget↔widget, widget↔layout and layout↔layout all
   * collide. Reported on the second occurrence in pre-order.
   */
  | "duplicate-node-id"
  /** A grid cell's `span` is not an integer in `1..columns`. */
  | "span-out-of-range"
  /**
   * A grid cell's placement (IR 2.1.0) cannot be laid out: `row`, `rowSpan` or `column` is not a
   * positive integer, `column` exceeds `columns`, or `column + span - 1` overflows the grid.
   */
  | "placement-out-of-range"
  /**
   * A layout's `role` (IR 2.2.0) is present but not a well-formed role (`isLayoutRole`): renderers
   * draw the plain container, so nothing is lost but the custom rendering — a `warn`. An unknown
   * but well-formed role is NOT a finding: whether a renderer has it registered is not loom's to say.
   */
  | "role-invalid"
  /**
   * A layout's `id` (IR 2.4.0, ADR 0101) is present but not a non-empty string: renderers treat it
   * as absent and key the container positionally, so nothing is lost but state preservation
   * across a recompose — a `warn`.
   */
  | "layout-id-invalid"
  /** A grid's `columns` is not a positive integer — there is no column count to lay cells into. */
  | "columns-invalid"
  /** A node that is neither a `Widget` nor a `Layout` (a stray `null`, a string, a stranded `GridCell`). */
  | "malformed-node"
  /** `binding.status.path` is empty or not a dotted path. */
  | "status-path-invalid"
  /** `binding.sensitivity` is not a `@loom/classify` `DataClass`. */
  | "sensitivity-unknown"
  /** `widget.source` (or a `degradedFrom` entry) is missing `type` or `version`. */
  | "source-invalid"
  /** `blueprint.irVersion` is set but not a version this module recognizes. */
  | "ir-version-unknown";

export interface BlueprintFinding {
  readonly code: BlueprintFindingCode;
  readonly severity: "error" | "warn";
  readonly message: string;
  /**
   * The node the finding applies to. For a widget-level finding it is the widget's id. For a
   * cell-level finding (`span-out-of-range`, `placement-out-of-range`) it is the id of the cell's
   * OWN node — a widget's id, or a nested layout's well-formed id (IR 2.4.0) — else `"<layout>"`.
   * For a layout-level finding (`columns-invalid`, `role-invalid`, `duplicate-node-id` on a
   * layout) it is the layout's well-formed id when it has one, else `"<layout>"`. For
   * `ir-version-unknown`, `malformed-node` and `layout-id-invalid` it is always `"<layout>"`.
   */
  readonly nodeId: string;
  /** The widget's kind, or `"<layout>"` for a layout-level finding. */
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

const KNOWN_IR_VERSIONS = new Set([IR_VERSION_LEGACY, ...IR_VERSIONS_READ_AS_IS]);
const DATA_CLASSES = new Set(["secret", "sensitive", "internal"]);
const DOTTED = /^[^.\s]+(\.[^.\s]+)*$/;

interface Visit {
  widget?: Widget;
  cell?: {
    span: number;
    columns: number;
    cellNodeId: string | undefined;
    /** Read as `unknown`: a model-composed artifact can put anything here. */
    row: unknown;
    rowSpan: unknown;
    column: unknown;
  };
  /** A layout's well-formed id (IR 2.4.0) — it joins the widget-id namespace. */
  layoutId?: { id: string };
  /** A layout whose `id` is present but not a non-empty string — read as `unknown`. */
  layoutIdInvalid?: { id: unknown };
  /** A grid whose `columns` is not a positive integer — reported once, and its cells are not checked. */
  columnsInvalid?: { columns: unknown; nodeId: string };
  /** A layout whose `role` is present but not `isLayoutRole` — read as `unknown`. */
  roleInvalid?: { role: unknown; nodeId: string };
  /** A tree node that is neither a `Widget` nor a `Layout`; the subtree below it is not walked. */
  malformed?: { node: unknown };
}

/**
 * A blueprint is DATA a model may have composed, so the walk cannot assume its own types hold.
 * A `Layout` here is structural: an object with a `type` and an array of `children`. Anything
 * else reaching the stack — `null`, a string, a `GridCell` stranded in a flex/stack — is a
 * `malformed-node` finding, never a property access on a non-object.
 */
const isLayoutNode = (n: unknown): n is Layout =>
  typeof n === "object" &&
  n !== null &&
  "type" in n &&
  Array.isArray((n as { children?: unknown }).children);

/**
 * Iterative walk — an explicit stack, so a deep tree cannot blow the call stack.
 * Visits widgets (pre-order) and grid cells. A grid's cells are visited in
 * forward sibling order (so findings on them read in document order) before
 * their nodes are pushed onto the stack in reverse, which keeps the overall
 * widget walk pre-order.
 *
 * The loop is length-driven rather than `pop() !== undefined`: a literal `undefined` child is
 * one of the malformed shapes this walk must REPORT, and a sentinel loop would silently end the
 * walk on it instead.
 */
function eachNode(root: Layout | Widget, visit: (v: Visit) => void): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isWidget(node)) {
      visit({ widget: node });
      continue;
    }
    if (!isLayoutNode(node)) {
      visit({ malformed: { node } });
      continue;
    }
    // `undefined` is absent (it does not survive serialisation, and every builder omits it).
    // A malformed id is ABSENT for every other purpose: it names nothing and collides with nothing.
    const id = (node as { id?: unknown }).id;
    const nodeId = hasLayoutId(node) ? node.id : "<layout>";
    if (hasLayoutId(node)) visit({ layoutId: { id: node.id } });
    else if (id !== undefined) visit({ layoutIdInvalid: { id } });
    const role = (node as { role?: unknown }).role;
    if (role !== undefined && !isLayoutRole(role)) visit({ roleInvalid: { role, nodeId } });
    if (node.type === "grid") {
      const children = node.children as Array<GridCell | Widget | Layout>;
      const columns = (node as { columns?: unknown }).columns;
      // A grid with no usable column count cannot place ANY cell, so every span would be
      // "out of range" against it. Report the cause once and skip the cascade.
      const columnsOk = Number.isInteger(columns) && (columns as number) >= 1;
      if (!columnsOk) {
        visit({ columnsInvalid: { columns, nodeId } });
      } else {
        for (let i = 0; i < children.length; i++) {
          const c = asCell(children[i] as GridCell | Widget | Layout);
          visit({
            cell: {
              span: c.span ?? 1,
              columns: columns as number,
              cellNodeId: isWidget(c.node)
                ? c.node.id
                : hasLayoutId(c.node)
                  ? c.node.id
                  : undefined,
              row: c.row,
              rowSpan: c.rowSpan,
              column: c.column,
            },
          });
        }
      }
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(asCell(children[i] as GridCell | Widget | Layout).node);
      }
    } else {
      const children = node.children as unknown[];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
  }
}

/** A bounded description of a malformed role or id: a model-composed value can be any size. */
function describeValue(value: unknown): string {
  if (typeof value !== "string") {
    if (value === null) return "null";
    return Array.isArray(value) ? "(an array)" : `(a ${typeof value})`;
  }
  return value.length > 64
    ? `${JSON.stringify(value.slice(0, 64))}… (${value.length} chars)`
    : JSON.stringify(value);
}

/** A short, safe description of a malformed node for a finding message. */
function describeNode(node: unknown): string {
  if (node === null) return "null";
  if (Array.isArray(node)) return "an array";
  const t = typeof node;
  if (t !== "object") return `a ${t}`;
  if ("node" in (node as object)) return "a GridCell outside a grid";
  return "an object with no layout `type` or `children`";
}

const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
const show = (v: unknown): string => JSON.stringify(v) ?? String(v);

/**
 * Why a cell's placement cannot be laid out — empty when it can. `spanOk` gates the overflow
 * test so an invalid span is reported once (as `span-out-of-range`), not again as an overflow.
 */
function placementProblems(c: {
  row: unknown;
  rowSpan: unknown;
  column: unknown;
  span: number;
  spanOk: boolean;
  columns: number;
}): string[] {
  const out: string[] = [];
  if (c.row !== undefined && !isPositiveInt(c.row))
    out.push(`row ${show(c.row)} is not a positive integer`);
  if (c.rowSpan !== undefined && !isPositiveInt(c.rowSpan))
    out.push(`rowSpan ${show(c.rowSpan)} is not a positive integer`);
  if (c.column !== undefined) {
    if (!isPositiveInt(c.column) || c.column > c.columns)
      out.push(`column ${show(c.column)} is outside 1..${c.columns}`);
    else if (c.spanOk && c.column + c.span - 1 > c.columns)
      out.push(`column ${c.column} + span ${c.span} overflows the ${c.columns}-column grid`);
  }
  return out;
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
  // ONE namespace: widget ids and layout ids (IR 2.4.0) are both node identity.
  // The value records which kind of node claimed the id first, so a widget↔widget collision keeps
  // its message and a collision involving a layout says so.
  const seenIds = new Map<string, "widget" | "layout">();
  let widgets = 0;

  if (blueprint.irVersion !== undefined && !KNOWN_IR_VERSIONS.has(blueprint.irVersion)) {
    findings.push({
      code: "ir-version-unknown",
      severity: "error",
      nodeId: "<layout>",
      kind: "<layout>",
      message: `irVersion "${blueprint.irVersion}" is not a version this module recognizes — a reader may not know how to interpret the artifact`,
    });
  }

  eachNode(blueprint.layout, (v) => {
    if (v.layoutId) {
      const { id } = v.layoutId;
      if (seenIds.has(id)) {
        findings.push({
          code: "duplicate-node-id",
          severity: "error",
          nodeId: id,
          kind: "<layout>",
          message: `a layout shares the id "${id}" with an earlier node — widget and layout ids are one namespace, so node identity and the renderer's key collide`,
        });
      }
      if (!seenIds.has(id)) seenIds.set(id, "layout");
      return;
    }

    if (v.layoutIdInvalid) {
      findings.push({
        code: "layout-id-invalid",
        severity: "warn",
        nodeId: "<layout>",
        kind: "<layout>",
        message: `layout id ${describeValue(v.layoutIdInvalid.id)} is not a non-empty string — renderers treat it as absent and key this container by position, so its state is not kept across a recompose`,
      });
      return;
    }

    if (v.columnsInvalid) {
      findings.push({
        code: "columns-invalid",
        severity: "error",
        nodeId: v.columnsInvalid.nodeId,
        kind: "<layout>",
        message: `grid columns ${JSON.stringify(v.columnsInvalid.columns) ?? "undefined"} is not a positive integer — there is no column count to place cells into, so this grid's spans are not checked`,
      });
      return;
    }

    if (v.roleInvalid) {
      findings.push({
        code: "role-invalid",
        severity: "warn",
        nodeId: v.roleInvalid.nodeId,
        kind: "<layout>",
        message: `layout role ${describeValue(v.roleInvalid.role)} is not a well-formed role (a lowercase letter, then lowercase letters, digits or hyphens, at most 64 characters) — renderers draw the plain container`,
      });
      return;
    }

    if (v.malformed) {
      findings.push({
        code: "malformed-node",
        severity: "error",
        nodeId: "<layout>",
        kind: "<layout>",
        message: `a layout child is neither a Widget nor a Layout (${describeNode(v.malformed.node)}) — it renders nothing, and the subtree below it is not validated`,
      });
      return;
    }

    if (v.cell) {
      const { span, columns, cellNodeId, row, rowSpan, column } = v.cell;
      const spanOk = Number.isInteger(span) && span >= 1 && span <= columns;
      if (!spanOk) {
        findings.push({
          code: "span-out-of-range",
          severity: "error",
          nodeId: cellNodeId ?? "<layout>",
          kind: "<layout>",
          message: `cell span ${span} is outside 1..${columns} — a renderer cannot lay this cell out`,
        });
      }
      const problems = placementProblems({ row, rowSpan, column, span, spanOk, columns });
      if (problems.length > 0) {
        findings.push({
          code: "placement-out-of-range",
          severity: "error",
          nodeId: cellNodeId ?? "<layout>",
          kind: "<layout>",
          message: `cell placement cannot be laid out — ${problems.join("; ")}`,
        });
      }
      return;
    }

    const widget = v.widget;
    if (!widget) return;
    widgets++;
    const { id, kind } = widget;

    const earlier = seenIds.get(id);
    if (earlier !== undefined) {
      findings.push({
        code: "duplicate-node-id",
        severity: "error",
        nodeId: id,
        kind,
        message:
          earlier === "widget"
            ? `two widgets share the id "${id}" — node identity and the renderer's key collide, so one silently replaces the other`
            : `a widget shares the id "${id}" with an earlier layout — widget and layout ids are one namespace, so node identity and the renderer's key collide`,
      });
    } else {
      seenIds.set(id, "widget");
    }

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

    // `binding` and `source` are typed, but a blueprint is data a model can compose —
    // a malformed value (null, a string, ...) must be a finding, never a property
    // access on a non-object, so every read below goes through a typeof guard first.
    const status = widget.binding?.status;
    if (status !== undefined) {
      const path =
        status !== null && typeof status === "object"
          ? (status as { path?: unknown }).path
          : undefined;
      if (typeof path !== "string" || path === "" || !DOTTED.test(path)) {
        findings.push({
          code: "status-path-invalid",
          severity: "error",
          nodeId: id,
          kind,
          message: `binding.status.path ${JSON.stringify(path)} is not a non-empty dotted path`,
        });
      }
    }

    const sensitivity = widget.binding?.sensitivity;
    if (sensitivity !== undefined && !DATA_CLASSES.has(sensitivity as string)) {
      findings.push({
        code: "sensitivity-unknown",
        severity: "error",
        nodeId: id,
        kind,
        message: `binding.sensitivity ${JSON.stringify(sensitivity)} is not a @loom/classify DataClass`,
      });
    }

    const source = widget.source;
    if (source !== undefined) {
      const src =
        source !== null && typeof source === "object"
          ? (source as { type?: unknown; version?: unknown; degradedFrom?: unknown })
          : undefined;
      const degradedFrom = Array.isArray(src?.degradedFrom) ? src.degradedFrom : undefined;
      // Typed as `string`, so a NON-string is exactly what a hand-assembled artifact gets wrong.
      // A truthiness test would accept `type: 123` and `version: {}` — both render as garbage.
      const notAName = (v: unknown) => typeof v !== "string" || v === "";
      const invalid =
        src === undefined ||
        notAName(src.type) ||
        notAName(src.version) ||
        (src.degradedFrom !== undefined && degradedFrom === undefined) ||
        (degradedFrom?.some(
          (d: unknown) =>
            typeof d !== "object" ||
            d === null ||
            notAName((d as { type?: unknown }).type) ||
            notAName((d as { version?: unknown }).version)
        ) ??
          false);
      if (invalid) {
        findings.push({
          code: "source-invalid",
          severity: "error",
          nodeId: id,
          kind,
          message: `widget.source is missing a non-empty string "type" or "version" — either on the source itself or a degradedFrom entry (which must be an array)`,
        });
      }
    }
  });

  return {
    ok: findings.every((f) => f.severity !== "error"),
    findings,
    widgets,
  };
}
