import type React from "react";
import type { WidgetRendererProps } from "../RendererRegistry";

const SEVERITIES = new Set(["info", "warning", "error", "critical"]);

export const AlertCardRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const props = widget.props as { severity?: string };
  // An unrecognised severity falls back to `info` rather than being interpolated
  // into the class name, so a bound string can never author a style hook.
  const severity =
    props.severity !== undefined && SEVERITIES.has(props.severity) ? props.severity : "info";
  const message = value === undefined || value === null ? "—" : String(value);

  return (
    <div
      data-widget-kind="AlertCard"
      data-widget-id={widget.id}
      data-severity={severity}
      className={`alert alert--${severity}`}
      role={severity === "error" || severity === "critical" ? "alert" : "status"}
    >
      {widget.title && <div className="alert-title">{widget.title}</div>}
      <div className="alert-message">{message}</div>
    </div>
  );
};
