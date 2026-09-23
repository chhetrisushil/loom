import type { BindingStatus, Widget } from "@loom/blueprint-runtime";
import type React from "react";

// ── WidgetFrame ────────────────────────────────────────────────────────────────
//
// Applies the canonical binding-status matrix (IR 2.0.0) around a widget's
// rendered body: error/empty/stale/pending/loading markers (`empty` since IR 2.3.0, ADR 0100), and `Widget.source` as
// data attributes for a degraded-rendering tooltip. A widget with NOTHING to
// say — no declared status channel (`binding.status` absent) AND no `source`
// — renders `children` directly with no wrapping element at all: a 1.0.0
// artifact's DOM is byte-identical to before this component existed. The
// frame (and its attributes/markers) appears only once there is a status
// channel or a `source` to report.
//
// Between `error`/`empty` and `stale` the matrix leaves one documented slot: an optional `check(widget,
// value)` the CALLER supplies. loom never validates a value; a framework's own kind contract
// plugs in there and renders as the error row when it fails.

type Shown = "error" | "empty" | "stale" | "pending" | "loading" | "ready";

function shown(
  hasChannel: boolean,
  status: BindingStatus | undefined,
  value: unknown
): Shown | undefined {
  if (!hasChannel) return undefined; // no channel declared → 1.0.0 behaviour, frame is inert
  if (status?.state === "error") return "error";
  // The upstream answered with no subject to show. Not an error; a value beside it is ignored.
  if (status?.state === "empty") return "empty";
  if (status?.state === "stale") return "stale";
  if (status?.state === "pending") return value === undefined ? "loading" : "pending";
  // `status` undefined (not yet written, or malformed) is treated the same as
  // no status: a value that already exists is shown as "ready" rather than
  // hidden behind a spinner just because its status write hasn't landed.
  return value === undefined ? "loading" : "ready";
}

const chain = (w: Widget) =>
  w.source?.degradedFrom?.map((d) => `${d.type}@${d.version}`).join(" › ");

/**
 * A caller-supplied value-contract check — the documented slot the matrix leaves between
 * `error` and `stale` (design §5). loom validates nothing about a bound VALUE itself: what a
 * `Trend` or an `Investigation` must look like is a framework's catalogue vocabulary, not the
 * IR's. A framework plugs its own `checkKindValue` in here; a finding renders as the error row.
 */
export type WidgetValueCheck = (
  widget: Widget,
  value: unknown
) => { code: string; message: string } | undefined;

export const WidgetFrame: React.FC<{
  widget: Widget;
  value: unknown;
  status?: BindingStatus;
  /**
   * Runs only for a widget whose binding declares a status channel, and only when there is a
   * value to check: not under `error` (the fetch itself failed) nor `empty` (the upstream
   * answered with nothing). A returned finding outranks `stale`, `pending` and `ready`.
   */
  check?: WidgetValueCheck;
  children: React.ReactNode;
}> = ({ widget, value, status, check, children }) => {
  const hasChannel = widget.binding?.status !== undefined;
  const hasSource = widget.source !== undefined;
  if (!hasChannel && !hasSource) {
    // Nothing to report — no wrapper, no attributes, no DOM node added.
    return children;
  }
  const noValue = status?.state === "error" || status?.state === "empty";
  const contract = hasChannel && !noValue ? check?.(widget, value) : undefined;
  const state = contract ? "error" : shown(hasChannel, status, value);
  const errorMessage = contract ? contract.message : (status?.finding?.message ?? "error");
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
          ✗ {title}: {errorMessage}
        </div>
      )}
      {state === "empty" && (
        // A polite live region: announced like a status, never as an alert — it is not an error.
        // biome-ignore lint/a11y/useSemanticElements: <output> is a calculation result, and its implicit live-region support varies by screen reader; an explicit role="status" on a div is the reliably announced form
        <div role="status" data-binding-marker="empty">
          ○ {title}: {status?.finding?.message ?? "no data"}
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
