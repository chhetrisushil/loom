import type React from "react";
import type { Widget, WidgetKind } from "@loom/blueprint-runtime";

export interface WidgetAction {
  type: string;
  widgetId: string;
  payload?: unknown;
}

export interface WidgetRendererProps {
  widget: Widget;
  value: unknown;
  onAction?: (action: WidgetAction) => void;
}

export type WidgetRenderer = React.FC<WidgetRendererProps>;

export class RendererRegistry {
  private readonly renderers = new Map<WidgetKind, WidgetRenderer>();

  register(kind: WidgetKind, renderer: WidgetRenderer): void {
    this.renderers.set(kind, renderer);
  }

  get(kind: WidgetKind): WidgetRenderer | undefined {
    return this.renderers.get(kind);
  }

  has(kind: WidgetKind): boolean {
    return this.renderers.has(kind);
  }
}

export const defaultRegistry = new RendererRegistry();
