import type React from "react";
import type { WidgetRendererProps } from "../RendererRegistry";

export const StatusBadgeRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const status = typeof value === "string" ? value : "unknown";
  return (
    <div data-widget-kind="StatusBadge" data-widget-id={widget.id}>
      {widget.title && <span className="badge-title">{widget.title}</span>}
      <span className={`badge badge--${status}`}>{status}</span>
    </div>
  );
};
