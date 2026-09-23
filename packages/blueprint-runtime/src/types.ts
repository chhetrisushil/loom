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

import type { DataClass } from "@loom/classify";

/**
 * `empty` (IR 2.3.0, ADR 0100): delivery succeeded and the upstream answered with NO subject to
 * show (e.g. a template indexed past the end of an empty array). It is not an error and triggers
 * nothing; a value written beside it is ignored by every renderer.
 */
export type BindingState = "pending" | "ready" | "stale" | "error" | "empty";
/** A binding's delivery state, read from the same projection state as its value (IR 2.0.0). */
export interface BindingStatus {
  state: BindingState;
  /** Monotonic per binding; lets a renderer coalesce out-of-order updates. */
  seq?: number;
  finding?: { code: string; message: string };
}

export interface DataBinding {
  projectionId: string;
  path: string;
  /** Where, in the SAME projection state, this binding's status lives. Absent ⇒ no status channel. */
  status?: { path: string };
  /** `@loom/classify` DataClass. Read by compilers and delivery; never by renderers. */
  sensitivity?: DataClass;
}

/** What a widget stands for: the semantic type it renders and the degradations that led to `kind`. */
export interface WidgetSource {
  type: string;
  version: string;
  /** Outermost first. */
  degradedFrom?: Array<{ type: string; version: string }>;
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
  source?: WidgetSource;
}

/**
 * One child of a grid: the columns it occupies (`span`, default 1) and, since IR 2.1.0
 * (ADR 0098), an optional explicit placement. Every placement field is independently optional;
 * all absent = flow placement (the grid's auto-placement, exactly as under 2.0.0). Coordinates
 * are 1-based grid lines: `column` is the start column (the cell occupies `column..column+span-1`),
 * `row` the start row, `rowSpan` the rows occupied (default 1).
 */
export interface GridCell {
  span?: number;
  row?: number;
  rowSpan?: number;
  column?: number;
  node: Widget | Layout;
}
export interface GridLayout {
  type: "grid";
  columns: number;
  gap?: number;
  /** A section heading for this container (IR 2.1.0). Absent ⇒ no heading. */
  title?: string;
  /**
   * What this container IS to a renderer that knows it (IR 2.2.0, ADR 0099) — the open,
   * app-defined axis for containers that `Widget.kind` is for widgets (`"stepped"`, `"tabbed"`,
   * …). `type` stays the geometry. Absent, malformed (see `isLayoutRole`) or unknown to the
   * renderer in use ⇒ the plain container. Never an ARIA role, never display text.
   */
  role?: string;
  children: GridCell[];
}

export interface FlexLayout {
  type: "flex";
  direction: "row" | "column";
  gap?: number;
  /** A section heading for this container (IR 2.1.0). Absent ⇒ no heading. */
  title?: string;
  /**
   * What this container IS to a renderer that knows it (IR 2.2.0, ADR 0099) — the open,
   * app-defined axis for containers that `Widget.kind` is for widgets (`"stepped"`, `"tabbed"`,
   * …). `type` stays the geometry. Absent, malformed (see `isLayoutRole`) or unknown to the
   * renderer in use ⇒ the plain container. Never an ARIA role, never display text.
   */
  role?: string;
  children: Array<Widget | Layout>;
}

export interface StackLayout {
  type: "stack";
  gap?: number;
  /** A section heading for this container (IR 2.1.0). Absent ⇒ no heading. */
  title?: string;
  /**
   * What this container IS to a renderer that knows it (IR 2.2.0, ADR 0099) — the open,
   * app-defined axis for containers that `Widget.kind` is for widgets (`"stepped"`, `"tabbed"`,
   * …). `type` stays the geometry. Absent, malformed (see `isLayoutRole`) or unknown to the
   * renderer in use ⇒ the plain container. Never an ARIA role, never display text.
   */
  role?: string;
  children: Array<Widget | Layout>;
}

export type Layout = GridLayout | FlexLayout | StackLayout;

export interface Blueprint {
  readonly _tag: "Blueprint";
  /** The IR shape this artifact was written in. Absent ⇒ "1.0.0". Writers always set it. */
  irVersion?: string;
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
  status?: BindingStatus;
  onAction?: (action: WidgetAction) => void;
}
