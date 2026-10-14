import {
  type BindingStatus,
  type Widget,
  type WidgetValueCheck,
  describeWidgetFrame,
  describeWidgetStatus,
} from "@loom/blueprint-runtime";
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

/**
 * A caller-supplied value-contract check — the documented slot the matrix leaves between
 * `error` and `stale` (design §5). loom validates nothing about a bound VALUE itself: what a
 * `Trend` or an `Investigation` must look like is a framework's catalogue vocabulary, not the
 * IR's. A framework plugs its own `checkKindValue` in here; a finding renders as the error row.
 */
export type { WidgetValueCheck };

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
  const d = describeWidgetStatus(widget, value, status, check);
  if (d.tag === "invalid") {
    // A malformed `source` is the error placeholder, never a throw and never the cause.
    return (
      <div data-widget-frame={widget.id} data-placeholder="error">
        {`[Renderer for ${widget.kind} failed]`}
      </div>
    );
  }
  const frame = describeWidgetFrame(widget, d);
  const m = frame.marker;
  if (d.tag === "redacted") {
    // IR 2.5.0: withheld for this surface's audience. Nothing of the widget is drawn or exposed —
    // not its title, kind, source type/version, nor `children` (the kind renderer never mounts).
    return (
      <div data-widget-frame={widget.id} data-binding-state="redacted">
        <div role={m?.role} data-binding-marker={m?.name}>
          {m?.text}
        </div>
      </div>
    );
  }
  const Tag = m?.block ? "div" : "span";
  return (
    <div
      data-widget-frame={widget.id}
      {...(frame.state !== undefined && { "data-binding-state": frame.state })}
      {...(frame.sourceType !== undefined && {
        "data-source-type": frame.sourceType,
        "data-source-version": frame.sourceVersion,
      })}
      {...(frame.degraded && { "data-degraded": frame.degraded, title: frame.tooltip })}
    >
      {m && (
        // `role="status"` is a polite live region (empty): announced like a status, never as an
        // alert — it is not an error. (Dynamic role: biome cannot flag it, so no suppression.)
        <Tag role={m.role} data-binding-marker={m.name} title={m.tooltip}>
          {m.text ?? m.glyph}
        </Tag>
      )}
      {d.showBody && children}
    </div>
  );
};
