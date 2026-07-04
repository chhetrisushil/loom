import React from "react";
import type { WidgetAction, WidgetRendererProps } from "../RendererRegistry";

export const ApprovalCardRenderer: React.FC<WidgetRendererProps> = ({
  widget,
  value,
  onAction,
}) => {
  const props = widget.props as {
    approveLabel?: string;
    rejectLabel?: string;
  };
  const pending = Boolean(value);

  const handleApprove = () => {
    const action: WidgetAction = { type: "APPROVE", widgetId: widget.id, payload: { approved: true } };
    onAction?.(action);
  };

  const handleReject = () => {
    const action: WidgetAction = { type: "REJECT", widgetId: widget.id, payload: { approved: false } };
    onAction?.(action);
  };

  return (
    <div data-widget-kind="ApprovalCard" data-widget-id={widget.id}>
      {widget.title && <div className="approval-title">{widget.title}</div>}
      {pending && (
        <div className="approval-actions">
          <button onClick={handleApprove}>{props.approveLabel ?? "Approve"}</button>
          <button onClick={handleReject}>{props.rejectLabel ?? "Reject"}</button>
        </div>
      )}
      {!pending && <div className="approval-resolved">No pending approval</div>}
    </div>
  );
};
