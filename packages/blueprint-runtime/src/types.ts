// ── Built-in widget kinds ────────────────────────────────────────────────────
// WidgetKind is a convenience union for the built-in widgets shipped with Loom.
// Widget.kind is widened to `string` so custom renderers can register any kind.
export type WidgetKind =
  | "MetricCard"
  | "Timeline"
  | "ApprovalCard"
  | "StatusBadge"
  | "ProgressBar"
  | "DataTable"
  | "AlertCard"
  | "StreamingText";

export interface DataBinding {
  projectionId: string;
  path: string;
}

export interface Widget {
  readonly _tag: "Widget";
  id: string;
  // Widened to `string` so custom widget kinds can be registered. Built-in
  // widgets still produce the exact WidgetKind literal via their builder fns.
  kind: string;
  title?: string;
  props: Record<string, unknown>;
  binding?: DataBinding;
}

export interface GridLayout {
  type: "grid";
  columns: number;
  gap?: number;
  children: Array<Widget | Layout>;
}

export interface FlexLayout {
  type: "flex";
  direction: "row" | "column";
  gap?: number;
  children: Array<Widget | Layout>;
}

export interface StackLayout {
  type: "stack";
  gap?: number;
  children: Array<Widget | Layout>;
}

export type Layout = GridLayout | FlexLayout | StackLayout;

export interface Blueprint {
  readonly _tag: "Blueprint";
  id: string;
  title: string;
  layout: Layout;
  projections: string[];
  /**
   * ADR 0095 — the declared semantics of the projections this view binds to, by id, as they
   * were at composition.
   *
   * It lives on the blueprint rather than beside it because a composed surface is
   * content-addressed: a field of the value is part of the address, so this is what makes
   * "the meaning of a view never changes silently" a property of the artifact instead of a
   * paragraph. A binding freezes a NAME; this freezes what that name meant.
   *
   * Read it with `blueprintPins`, compare it with `checkBlueprintPins`.
   */
  projectionVersions?: Readonly<Record<string, string>>;
}

// ── Framework-agnostic renderer contract ─────────────────────────────────────

export interface WidgetAction {
  type: string;
  widgetId: string;
  payload?: unknown;
}

// The props passed to any widget renderer regardless of framework.
export interface WidgetRendererProps {
  widget: Widget;
  value: unknown;
  onAction?: (action: WidgetAction) => void;
}
