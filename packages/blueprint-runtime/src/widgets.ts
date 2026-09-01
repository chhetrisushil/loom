import type { DataBinding, Widget } from "./types";

// A derived id, used when the caller supplies none. It is an IDENTITY, not a
// content address: a 32-bit non-cryptographic hash, scoped to one blueprint.
// Never treat it as an audit anchor for "which view was this" — use a real digest
// (`contentAddress` in @loom/plugin-content) for that.
//
// Because it is derived from the props, it CHANGES when any prop changes. That is
// correct for a view that is authored once and wrong for one a composer revises,
// which is why every builder accepts an explicit `id`.
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
  /**
   * Stable node id. Supply it when a composer will REVISE this view: the derived
   * id is a hash of kind + props, so editing any prop re-identifies the node —
   * remounting it, and breaking anything keyed on it (a pin, an annotation, an
   * agent's reference to it).
   */
  id?: string;
}

export function MetricCard(props: MetricCardProps): Widget {
  const { title, id, ...rest } = props;
  return {
    _tag: "Widget",
    id: id ?? stableId("MetricCard", props),
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
  /**
   * Stable node id. Supply it when a composer will REVISE this view: the derived
   * id is a hash of kind + props, so editing any prop re-identifies the node —
   * remounting it, and breaking anything keyed on it (a pin, an annotation, an
   * agent's reference to it).
   */
  id?: string;
}

export function Timeline(props: TimelineProps): Widget {
  const { title, id, ...rest } = props;
  return {
    _tag: "Widget",
    id: id ?? stableId("Timeline", props),
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
  /**
   * Stable node id. Supply it when a composer will REVISE this view: the derived
   * id is a hash of kind + props, so editing any prop re-identifies the node —
   * remounting it, and breaking anything keyed on it (a pin, an annotation, an
   * agent's reference to it).
   */
  id?: string;
}

export function ApprovalCard(props: ApprovalCardProps): Widget {
  const { title, id, ...rest } = props;
  return {
    _tag: "Widget",
    id: id ?? stableId("ApprovalCard", props),
    kind: "ApprovalCard",
    title,
    props: rest,
    binding: props.binding,
  };
}

export interface StatusBadgeProps {
  title?: string;
  binding: DataBinding;
  /**
   * Stable node id. Supply it when a composer will REVISE this view: the derived
   * id is a hash of kind + props, so editing any prop re-identifies the node —
   * remounting it, and breaking anything keyed on it (a pin, an annotation, an
   * agent's reference to it).
   */
  id?: string;
}

export function StatusBadge(props: StatusBadgeProps): Widget {
  const { title, id, ...rest } = props;
  return {
    _tag: "Widget",
    id: id ?? stableId("StatusBadge", props),
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
  /**
   * Stable node id. Supply it when a composer will REVISE this view: the derived
   * id is a hash of kind + props, so editing any prop re-identifies the node —
   * remounting it, and breaking anything keyed on it (a pin, an annotation, an
   * agent's reference to it).
   */
  id?: string;
}

export function ProgressBar(props: ProgressBarProps): Widget {
  const { title, id, ...rest } = props;
  return {
    _tag: "Widget",
    id: id ?? stableId("ProgressBar", props),
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
  /**
   * Stable node id. Supply it when a composer will REVISE this view: the derived
   * id is a hash of kind + props, so editing any prop re-identifies the node —
   * remounting it, and breaking anything keyed on it (a pin, an annotation, an
   * agent's reference to it).
   */
  id?: string;
}

export function DataTable(props: DataTableProps): Widget {
  const { title, id, ...rest } = props;
  return {
    _tag: "Widget",
    id: id ?? stableId("DataTable", props),
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
  /**
   * Stable node id. Supply it when a composer will REVISE this view: the derived
   * id is a hash of kind + props, so editing any prop re-identifies the node —
   * remounting it, and breaking anything keyed on it (a pin, an annotation, an
   * agent's reference to it).
   */
  id?: string;
}

export function AlertCard(props: AlertCardProps): Widget {
  const { title, id, ...rest } = props;
  return {
    _tag: "Widget",
    id: id ?? stableId("AlertCard", props),
    kind: "AlertCard",
    ...(title !== undefined && { title }),
    props: rest,
    binding: props.binding,
  };
}

export interface StreamingTextProps {
  title?: string;
  binding: DataBinding;
  placeholder?: string;
  id?: string;
}

export function StreamingText(props: StreamingTextProps): Widget {
  const { title, id, ...rest } = props;
  return {
    _tag: "Widget",
    id: id ?? stableId("StreamingText", props),
    kind: "StreamingText",
    ...(title !== undefined && { title }),
    props: rest,
    binding: props.binding,
  };
}
