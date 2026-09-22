import type { BindingStatus, Widget } from "@loom/blueprint-runtime";
import type React from "react";

// ── WidgetFrame ────────────────────────────────────────────────────────────────
//
// Applies the canonical binding-status matrix (IR 2.0.0) around a widget's
// rendered body: error/stale/pending/loading markers, and `Widget.source` as
// data attributes for a degraded-rendering tooltip. A widget with no declared
// status channel (`binding.status` absent) renders its child untouched — the
// frame is inert, so 1.0.0 blueprints are byte-for-byte unaffected.

type Shown = "error" | "stale" | "pending" | "loading" | "ready";

function shown(
  hasChannel: boolean,
  status: BindingStatus | undefined,
  value: unknown
): Shown | undefined {
  if (!hasChannel) return undefined; // no channel declared → 1.0.0 behaviour, frame is inert
  if (status?.state === "error") return "error";
  if (status?.state === "stale") return "stale";
  if (status?.state === "pending") return value === undefined ? "loading" : "pending";
  return value === undefined ? "loading" : "ready";
}

const chain = (w: Widget) =>
  w.source?.degradedFrom?.map((d) => `${d.type}@${d.version}`).join(" › ");

export const WidgetFrame: React.FC<{
  widget: Widget;
  value: unknown;
  status?: BindingStatus;
  children: React.ReactNode;
}> = ({ widget, value, status, children }) => {
  const state = shown(widget.binding?.status !== undefined, status, value);
  const degraded = chain(widget);
  const title = widget.title ?? widget.kind;
  return (
    <div
      data-widget-frame={widget.id}
      {...(state !== undefined && { "data-binding-state": state })}
      {...(widget.source && {
        "data-source-type": widget.source.type,
        "data-source-version": widget.source.version,
      })}
      {...(degraded && {
        "data-degraded": degraded,
        title: `${widget.source?.type}@${widget.source?.version} shown as ${widget.kind} (degraded from ${degraded})`,
      })}
    >
      {state === "error" && (
        <div role="alert" data-binding-marker="error">
          ✗ {title}: {status?.finding?.message ?? "error"}
        </div>
      )}
      {state === "stale" && value === undefined && (
        <div data-binding-marker="stale">
          ~ {title}: {status?.finding?.message ?? "stale"} — no value
        </div>
      )}
      {state === "stale" && value !== undefined && (
        <span data-binding-marker="stale" title={status?.finding?.message}>
          ~
        </span>
      )}
      {state === "pending" && <span data-binding-marker="pending">⋯</span>}
      {state === "loading" && <div data-binding-marker="loading">…</div>}
      {(state === undefined ||
        state === "ready" ||
        (state === "stale" && value !== undefined) ||
        state === "pending") &&
        children}
    </div>
  );
};
