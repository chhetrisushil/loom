import type { DataBinding, Widget } from "./types";

function stableId(kind: string, props: object): string {
  const str = kind + JSON.stringify(props, Object.keys(props as Record<string, unknown>).sort());
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return `${kind}-${(hash >>> 0).toString(16)}`;
}

export interface MetricCardProps {
  title: string;
  binding: DataBinding;
  unit?: string;
  format?: "number" | "percent" | "bytes";
}

export function MetricCard(props: MetricCardProps): Widget {
  const { title, ...rest } = props;
  return {
    _tag: "Widget",
    id: stableId("MetricCard", props),
    kind: "MetricCard",
    title,
    props: rest,
    binding: props.binding,
  };
}

export interface TimelineProps {
  title?: string;
  binding: DataBinding;
  maxItems?: number;
}

export function Timeline(props: TimelineProps): Widget {
  const { title, ...rest } = props;
  return {
    _tag: "Widget",
    id: stableId("Timeline", props),
    kind: "Timeline",
    ...(title !== undefined && { title }),
    props: rest,
    binding: props.binding,
  };
}

export interface ApprovalCardProps {
  title: string;
  binding: DataBinding;
  approveLabel?: string;
  rejectLabel?: string;
}

export function ApprovalCard(props: ApprovalCardProps): Widget {
  const { title, ...rest } = props;
  return {
    _tag: "Widget",
    id: stableId("ApprovalCard", props),
    kind: "ApprovalCard",
    title,
    props: rest,
    binding: props.binding,
  };
}

export interface StatusBadgeProps {
  title?: string;
  binding: DataBinding;
}

export function StatusBadge(props: StatusBadgeProps): Widget {
  const { title, ...rest } = props;
  return {
    _tag: "Widget",
    id: stableId("StatusBadge", props),
    kind: "StatusBadge",
    ...(title !== undefined && { title }),
    props: rest,
    binding: props.binding,
  };
}

export interface ProgressBarProps {
  title?: string;
  binding: DataBinding;
  max?: number;
}

export function ProgressBar(props: ProgressBarProps): Widget {
  const { title, ...rest } = props;
  return {
    _tag: "Widget",
    id: stableId("ProgressBar", props),
    kind: "ProgressBar",
    ...(title !== undefined && { title }),
    props: rest,
    binding: props.binding,
  };
}

export interface DataTableProps {
  title?: string;
  binding: DataBinding;
  columns?: string[];
}

export function DataTable(props: DataTableProps): Widget {
  const { title, ...rest } = props;
  return {
    _tag: "Widget",
    id: stableId("DataTable", props),
    kind: "DataTable",
    ...(title !== undefined && { title }),
    props: rest,
    binding: props.binding,
  };
}

export interface AlertCardProps {
  title?: string;
  binding: DataBinding;
  severity?: "info" | "warning" | "error" | "critical";
}

export function AlertCard(props: AlertCardProps): Widget {
  const { title, ...rest } = props;
  return {
    _tag: "Widget",
    id: stableId("AlertCard", props),
    kind: "AlertCard",
    ...(title !== undefined && { title }),
    props: rest,
    binding: props.binding,
  };
}
