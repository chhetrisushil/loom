import type { BindingStatus, Widget } from "./types";

// ── The canonical binding-status matrix, as one pure decision ─────────────────
//
// redacted > error > empty > contract > stale > pending/loading > ready (IR 2.0.0; `empty` since 2.3.0,
// ADR 0100). Every first-party renderer (React, terminal, DOM) used to carry its own copy of
// this ordering, its `degradedFrom` chain and its tolerance for a malformed `source`. They now
// DRAW from this descriptor and own only their output format (ADR 0127). The function reads
// nothing but its arguments and never throws on a malformed widget: a `source.degradedFrom` that
// is not an array of objects yields `{ tag: "invalid" }`, which every renderer draws as its
// error placeholder.

/** A caller-supplied value-contract check — the slot the matrix leaves between `empty` and `stale`. */
export type WidgetValueCheck = (
  widget: Widget,
  value: unknown
) => { code: string; message: string } | undefined;

/** What a widget with a declared status channel is showing. */
export type WidgetShownState =
  | "redacted"
  | "error"
  | "empty"
  | "stale"
  | "pending"
  | "loading"
  | "ready";

/** The decided status of one widget. `inert` = no status channel declared (IR 1.0.0 behaviour). */
export type WidgetStatusDescriptor =
  | {
      /** The widget (or its `source`) is malformed; draw the error placeholder, never the cause. */
      readonly tag: "invalid";
      readonly reason: string;
    }
  | {
      readonly tag: "inert" | WidgetShownState;
      /** The finding message (a failed contract check wins), with the matrix default applied. */
      readonly message: string;
      /** The raw finding message, no default: what a `stale` marker carries as its tooltip. */
      readonly finding: string | undefined;
      /** Whether a value is present beside the status. */
      readonly hasValue: boolean;
      /** Whether the widget's own body is drawn (inert, ready, pending, or stale with a value). */
      readonly showBody: boolean;
      /** `type@version › …`, outermost first; undefined when the widget is not degraded. */
      readonly degradedChain: string | undefined;
    };

const DEFAULT_MESSAGE: Record<WidgetShownState, string> = {
  redacted: "redacted",
  error: "error",
  empty: "no data",
  stale: "stale",
  pending: "",
  loading: "",
  ready: "",
};

const INVALID = Symbol("invalid");

const degradedChainOf = (widget: Widget): string | undefined | typeof INVALID => {
  const degraded: unknown = widget.source?.degradedFrom;
  if (degraded === undefined) return undefined;
  if (!Array.isArray(degraded)) return INVALID;
  const parts: string[] = [];
  for (const d of degraded as unknown[]) {
    if (typeof d !== "object" || d === null) return INVALID;
    const { type, version } = d as { type: unknown; version: unknown };
    parts.push(`${String(type)}@${String(version)}`);
  }
  return parts.join(" › ") || undefined;
};

/**
 * Decide what a widget shows. `check` is the optional caller value-contract check; it runs only
 * for a widget whose binding declares a status channel, and only when there is a subject to check
 * (not under `error` or `empty`). A finding outranks `stale`, `pending` and `ready`.
 */
export function describeWidgetStatus(
  widget: Widget,
  value: unknown,
  status: BindingStatus | undefined,
  check?: WidgetValueCheck
): WidgetStatusDescriptor {
  // IR 2.5.0: a redacted widget outranks everything — it is decided before `value`, `status`,
  // `check`, `binding`, `title` or a malformed `source.degradedFrom` is looked at, so none of them
  // can reach a renderer's output. The message is the constant, never data from the widget.
  if ((widget.source as { redacted?: unknown } | undefined)?.redacted === true) {
    return {
      tag: "redacted",
      message: DEFAULT_MESSAGE.redacted,
      finding: undefined,
      hasValue: false,
      showBody: false,
      degradedChain: undefined,
    };
  }
  const chain = degradedChainOf(widget);
  if (chain === INVALID)
    return { tag: "invalid", reason: "source.degradedFrom is not an array of objects" };
  const hasValue = value !== undefined;
  const base = { hasValue, degradedChain: chain };
  if (widget.binding?.status === undefined) {
    return { tag: "inert", message: "", finding: undefined, showBody: true, ...base };
  }
  const noValue = status?.state === "error" || status?.state === "empty";
  const contract = noValue ? undefined : check?.(widget, value);
  const finding = contract ? contract.message : status?.finding?.message;
  let tag: WidgetShownState;
  if (status?.state === "error") tag = "error";
  else if (status?.state === "empty") tag = "empty";
  else if (contract) tag = "error";
  else if (status?.state === "stale") tag = "stale";
  // `status` undefined (not yet written, or malformed) is treated like `ready`: a value that
  // already exists is shown rather than hidden behind a spinner.
  else if (!hasValue) tag = "loading";
  else tag = status?.state === "pending" ? "pending" : "ready";
  return {
    tag,
    message: finding ?? DEFAULT_MESSAGE[tag],
    finding,
    showBody: tag === "ready" || tag === "pending" || (tag === "stale" && hasValue),
    ...base,
  };
}

// ── What every surface says about a decided status: the frame facts ───────────
//
// `describeWidgetStatus` decides WHICH state wins; this names WHAT is shown for it — the
// `data-binding-state` value, the marker's name / ARIA role / glyph / line, the `data-source-*`
// attributes and the degraded-from tooltip. A renderer draws these in its own medium (DOM
// elements, React elements, text) and adds nothing of its own to the vocabulary. Pure; reads only
// its arguments. Consumers: `@loom/plugin-renderer-react`, `-terminal`, `-dom` (ADR 0127).

/** The marker one status draws. `text` is the whole line for the markers that carry one. */
export interface WidgetStatusMarker {
  /** `data-binding-marker`. */
  readonly name: Exclude<WidgetShownState, "ready">;
  /** `alert` for error; `status` for empty and redacted (a polite live region); otherwise none. */
  readonly role: "alert" | "status" | undefined;
  readonly glyph: string;
  /** `glyph title: message` (error, empty), `… — no value` (stale, no value); else undefined. */
  readonly text: string | undefined;
  /** A stale marker beside a drawn value is glyph-only and carries the finding as its tooltip. */
  readonly tooltip: string | undefined;
  /** Block-level (a row) vs inline (a glyph beside the body). */
  readonly block: boolean;
}

export interface WidgetStatusFrame {
  /** `data-binding-state`; undefined for an inert widget. */
  readonly state: WidgetShownState | undefined;
  readonly sourceType: string | undefined;
  readonly sourceVersion: string | undefined;
  /** `data-degraded`: the chain, outermost first. */
  readonly degraded: string | undefined;
  /** The `title` attribute of a degraded widget. */
  readonly tooltip: string | undefined;
  /** The marker to draw before the body, or undefined (inert, ready). */
  readonly marker: WidgetStatusMarker | undefined;
}

/**
 * The surface-independent facts of a decided status. A redacted widget yields the constant marker
 * and no source/degraded facts (nothing of the widget may reach the output).
 */
export function describeWidgetFrame(
  widget: Widget,
  d: Exclude<WidgetStatusDescriptor, { tag: "invalid" }>
): WidgetStatusFrame {
  if (d.tag === "redacted") {
    return {
      state: "redacted",
      sourceType: undefined,
      sourceVersion: undefined,
      degraded: undefined,
      tooltip: undefined,
      marker: {
        name: "redacted",
        role: "status",
        glyph: "⊘",
        text: `⊘ ${d.message}`,
        tooltip: undefined,
        block: true,
      },
    };
  }
  const label = widget.title ?? widget.kind;
  const degraded = d.degradedChain;
  let marker: WidgetStatusMarker | undefined;
  const row = (
    name: WidgetStatusMarker["name"],
    role: WidgetStatusMarker["role"],
    glyph: string,
    text: string | undefined,
    block: boolean,
    tooltip?: string
  ): WidgetStatusMarker => ({ name, role, glyph, text, tooltip, block });
  switch (d.tag) {
    case "error":
      marker = row("error", "alert", "✗", `✗ ${label}: ${d.message}`, true);
      break;
    case "empty":
      marker = row("empty", "status", "○", `○ ${label}: ${d.message}`, true);
      break;
    case "stale":
      marker = d.hasValue
        ? row("stale", undefined, "~", undefined, false, d.finding)
        : row("stale", undefined, "~", `~ ${label}: ${d.message} — no value`, true);
      break;
    case "pending":
      marker = row("pending", undefined, "⋯", undefined, false);
      break;
    case "loading":
      marker = row("loading", undefined, "…", undefined, true);
      break;
    default:
      marker = undefined;
  }
  return {
    state: d.tag === "inert" ? undefined : d.tag,
    sourceType: widget.source?.type,
    sourceVersion: widget.source?.version,
    degraded,
    tooltip: degraded
      ? `${widget.source?.type}@${widget.source?.version} shown as ${widget.kind} (degraded from ${degraded})`
      : undefined,
    marker,
  };
}
