export type WidgetKind =
  | "MetricCard"
  | "Timeline"
  | "ApprovalCard"
  | "StatusBadge"
  | "ProgressBar"
  | "DataTable"
  | "AlertCard";

export interface DataBinding {
  projectionId: string;
  path: string;
}

export interface Widget {
  readonly _tag: "Widget";
  id: string;
  kind: WidgetKind;
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
}
