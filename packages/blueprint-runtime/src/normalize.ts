import { BLUEPRINT_IR_VERSION } from "./irVersion";
import type { BindingStatus, Blueprint, GridCell, Layout, Widget } from "./types";

export const IR_VERSION_LEGACY = "1.0.0";

// ── Path resolution ───────────────────────────────────────────────────────────
//
// Lives here (not traverseBlueprint.ts) to avoid an import cycle: traverseBlueprint imports
// `asCell` from this module, and `resolveWidgetStatus` below needs `resolvePath`. Re-exported
// from traverseBlueprint.ts unchanged for existing consumers.

// Resolve a dot-path (e.g. "a.b.c") against a projection state. Null-safe and
// generic — no widget/UI coupling — so any live rendering surface can build a
// slice selector for `ProjectionRuntime.subscribeSelector` without duplicating
// this traversal (see useWidgetValue). An empty path binds to the whole state.
export function resolvePath(state: unknown, path: string): unknown {
  // An empty path binds the widget to the whole projection surface (the root),
  // not a nested field — otherwise `"".split(".")` yields `[""]` and dereferences
  // a non-existent "" key, silently returning undefined.
  if (path === "") return state;
  const parts = path.split(".");
  let current: unknown = state;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export const isWidget = (n: unknown): n is Widget =>
  typeof n === "object" && n !== null && (n as { _tag?: unknown })._tag === "Widget";
const isCell = (n: unknown): n is GridCell =>
  typeof n === "object" && n !== null && "node" in n && !("_tag" in n) && !("type" in n);

/** The one place a legacy bare grid child becomes a cell. Every walker calls this; nothing else branches on the union. */
export function asCell(child: GridCell | Widget | Layout): GridCell {
  return isCell(child) ? child : { span: 1, node: child };
}
/** An explicit-span cell, optionally placed (IR 2.1.0). Only the placement fields given are written. */
export function cell(
  span: number,
  node: Widget | Layout,
  placement: Pick<GridCell, "row" | "rowSpan" | "column"> = {}
): GridCell {
  return {
    span,
    node,
    ...(placement.row !== undefined && { row: placement.row }),
    ...(placement.rowSpan !== undefined && { rowSpan: placement.rowSpan }),
    ...(placement.column !== undefined && { column: placement.column }),
  };
}

export function blueprintIrVersion(bp: Blueprint): string {
  return bp.irVersion ?? IR_VERSION_LEGACY;
}

function upgradeLayout(layout: Layout): Layout {
  if (layout.type === "grid") {
    return {
      ...layout,
      children: (layout.children as Array<GridCell | Widget | Layout>).map((c) => {
        const k = asCell(c);
        return isWidget(k.node) ? k : { ...k, node: upgradeLayout(k.node) };
      }),
    };
  }
  return { ...layout, children: layout.children.map((c) => (isWidget(c) ? c : upgradeLayout(c))) };
}

/**
 * Every IR version this build reads AS-IS. 2.1.0 (ADR 0098) and 2.2.0 (ADR 0099) only added
 * optional fields, and 2.3.0 (ADR 0100) only a `BindingState` literal (a runtime status value
 * no artifact carries), so a 2.0.0, 2.1.0 or 2.2.0 artifact is already a valid current-major
 * artifact: re-stamping it would change its content address with no change to its shape.
 *
 * Add the outgoing version here on every minor bump.
 */
export const IR_VERSIONS_READ_AS_IS: ReadonlySet<string> = new Set([
  "2.0.0",
  "2.1.0",
  "2.2.0",
  BLUEPRINT_IR_VERSION,
]);

/**
 * A current-major artifact from any readable one. Identity (same reference) on 2.0.0, 2.1.0,
 * 2.2.0 and 2.3.0 input; a 1.0.0 (or unstamped) artifact is wrapped and stamped. Never mutates its
 * input.
 */
export function upgradeBlueprint(bp: Blueprint): Blueprint {
  if (bp.irVersion !== undefined && IR_VERSIONS_READ_AS_IS.has(bp.irVersion)) return bp;
  return { ...bp, irVersion: BLUEPRINT_IR_VERSION, layout: upgradeLayout(bp.layout) };
}

// `empty` since IR 2.3.0 (ADR 0100). A reader built before it rejects `{ state: "empty" }` here,
// so the status resolves to `undefined` and that reader's matrix falls back to loading/ready —
// never to the error row (ADR 0100 D4).
const STATES = new Set(["pending", "ready", "stale", "error", "empty"]);
export function isBindingStatus(v: unknown): v is BindingStatus {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.state !== "string" || !STATES.has(s.state)) return false;
  if (s.seq !== undefined && typeof s.seq !== "number") return false;
  if (s.finding !== undefined) {
    const f = s.finding as Record<string, unknown> | null;
    if (
      typeof f !== "object" ||
      f === null ||
      typeof f.code !== "string" ||
      typeof f.message !== "string"
    )
      return false;
  }
  return true;
}

/** Status lives in the SAME projection state as the value; a malformed value is `undefined`, never a throw. */
export function resolveWidgetStatus(
  widget: Widget,
  stateMap: Map<string, unknown>
): BindingStatus | undefined {
  const b = widget.binding;
  if (b?.status === undefined) return undefined;
  const raw = resolvePath(stateMap.get(b.projectionId), b.status.path);
  return isBindingStatus(raw) ? raw : undefined;
}
