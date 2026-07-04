import React from "react";
import type { WidgetRendererProps } from "../RendererRegistry";

interface TimelineEntry {
  timestamp?: number | string;
  message?: string;
  level?: string;
}

export const TimelineRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const entries: TimelineEntry[] = Array.isArray(value) ? (value as TimelineEntry[]) : [];

  return (
    <div data-widget-kind="Timeline" data-widget-id={widget.id}>
      {widget.title && <div className="timeline-title">{widget.title}</div>}
      <ul className="timeline-entries">
        {entries.map((entry, i) => (
          <li key={i} className="timeline-entry" data-level={entry.level}>
            {entry.timestamp && (
              <span className="timeline-ts">{String(entry.timestamp)}</span>
            )}
            <span className="timeline-msg">{entry.message ?? ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
