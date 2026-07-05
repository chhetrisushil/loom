import type React from "react";
import type { WidgetRendererProps } from "../RendererRegistry";

export const StreamingTextRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const props = widget.props as { placeholder?: string };
  const text = value != null ? String(value) : (props.placeholder ?? "");

  return (
    <div data-widget-kind="StreamingText" data-widget-id={widget.id}>
      {widget.title !== undefined && <div className="streaming-title">{widget.title}</div>}
      <pre className="streaming-content" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
        {text}
      </pre>
    </div>
  );
};
