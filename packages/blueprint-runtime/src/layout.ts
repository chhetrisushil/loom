import { asCell } from "./normalize";
import type { FlexLayout, GridCell, GridLayout, Layout, StackLayout, Widget } from "./types";

export interface GridOptions {
  columns: number;
  gap?: number;
  /** A section heading (IR 2.1.0). */
  title?: string;
  children: Array<GridCell | Widget | Layout>;
}

export function grid(options: GridOptions): GridLayout {
  return {
    type: "grid",
    columns: options.columns,
    ...(options.gap !== undefined && { gap: options.gap }),
    ...(options.title !== undefined && { title: options.title }),
    children: options.children.map(asCell),
  };
}

export interface FlexOptions {
  direction?: "row" | "column";
  gap?: number;
  /** A section heading (IR 2.1.0). */
  title?: string;
  children: Array<Widget | Layout>;
}

export function flex(options: FlexOptions): FlexLayout {
  return {
    type: "flex",
    direction: options.direction ?? "row",
    ...(options.gap !== undefined && { gap: options.gap }),
    ...(options.title !== undefined && { title: options.title }),
    children: options.children,
  };
}

export interface StackOptions {
  gap?: number;
  /** A section heading (IR 2.1.0). */
  title?: string;
  children: Array<Widget | Layout>;
}

export function stack(options: StackOptions): StackLayout {
  return {
    type: "stack",
    ...(options.gap !== undefined && { gap: options.gap }),
    ...(options.title !== undefined && { title: options.title }),
    children: options.children,
  };
}
