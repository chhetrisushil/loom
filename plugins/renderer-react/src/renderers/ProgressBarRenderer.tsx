import type React from "react";
import type { WidgetRendererProps } from "../RendererRegistry";

export const ProgressBarRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const props = widget.props as { max?: number };
  const max = typeof props.max === "number" && props.max > 0 ? props.max : 100;
  const current = typeof value === "number" && Number.isFinite(value) ? value : undefined;

  return (
    <div data-widget-kind="ProgressBar" data-widget-id={widget.id}>
      {widget.title && <div className="progress-title">{widget.title}</div>}
      {/* A native <progress> rather than a div with role="progressbar": the
          element carries the semantics for free, and omitting `value` is the
          standard representation of an INDETERMINATE bar. That distinction is
          the point — an unresolved binding must not render as 0%, because a bar
          at zero and a bar with no data look identical and mean opposite
          things. */}
      <progress
        className="progress-track"
        aria-label={widget.title ?? "progress"}
        max={max}
        {...(current !== undefined && { value: current })}
      />
      <div className="progress-value">{current === undefined ? "—" : `${current} / ${max}`}</div>
    </div>
  );
};
