import React from "react";
import type { WidgetRendererProps } from "../RendererRegistry";

export const MetricCardRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const props = widget.props as { unit?: string; format?: string };
  const displayValue =
    value !== undefined && value !== null ? String(value) : "—";

  return (
    <div data-widget-kind="MetricCard" data-widget-id={widget.id}>
      {widget.title && <div className="metric-title">{widget.title}</div>}
      <div className="metric-value">
        {displayValue}
        {props.unit && <span className="metric-unit">{props.unit}</span>}
      </div>
    </div>
  );
};
