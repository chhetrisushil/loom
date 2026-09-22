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
export function cell(span: number, node: Widget | Layout): GridCell {
  return { span, node };
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

/** A 2.0.0 artifact from any readable one. Identity (same reference) on 2.0.0 input; never mutates its input. */
export function upgradeBlueprint(bp: Blueprint): Blueprint {
  if (bp.irVersion === BLUEPRINT_IR_VERSION) return bp;
  return { ...bp, irVersion: BLUEPRINT_IR_VERSION, layout: upgradeLayout(bp.layout) };
}

const STATES = new Set(["pending", "ready", "stale", "error"]);
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
