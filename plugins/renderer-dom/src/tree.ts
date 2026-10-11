import {
  type BindingStatus,
  type Layout,
  type RendererRegistry,
  type Widget,
  type WidgetAction,
  type WidgetValueCheck,
  asCell,
  describeWidgetStatus,
  isLayoutId,
  isWidget,
  resolveWidgetStatus,
  resolveWidgetValue,
} from "@loom/blueprint-runtime";
import { deepEqual } from "./deepEqual";
import type { DomWidgetRenderer } from "./defaultRegistry";
import { h } from "./safeDom";

// ── The entry tree ────────────────────────────────────────────────────────────
//
// A blueprint is mounted into a tree of ENTRIES that mirrors the DOM one-for-one: a
// `WidgetEntry` per widget host, a `ContainerEntry` per layout. Mounting and landing a revised
// blueprint are the same walk (`reconcile`), so there is one code path to get right. Widgets
// are keyed by id, containers by layout id (IR 2.4.0) or — without one — by their ordinal among
// the id-less siblings + type; a matched entry keeps its DOM node, an unmatched one is created
// or swept. Nothing in this file touches `innerHTML`; all markup goes through `h`.

/** A caller-supplied value-contract check (the slot between `error`/`empty` and `stale`). */
export type { WidgetValueCheck };

export interface Ctx {
  readonly doc: Document;
  readonly registry: RendererRegistry<DomWidgetRenderer>;
  readonly check?: WidgetValueCheck;
  readonly onAction?: (action: WidgetAction) => unknown;
  /** The projection states by id. One instance for the whole handle, rewritten in place. */
  readonly stateMap: Map<string, unknown>;
  /** The live widgets by the projection they are bound to — what a state change re-draws. */
  readonly byProjection: Map<string, Set<WidgetEntry>>;
  /** Widget ids disposed / mounted by the pass in flight; their intersection is `remounted`. */
  readonly disposed: Set<string>;
  readonly mounted: Set<string>;
}

export interface WidgetEntry {
  readonly kind: "widget";
  readonly key: string;
  readonly host: HTMLElement;
  widget: Widget;
  value: unknown;
  status: BindingStatus | undefined;
  alive: boolean;
}
export interface ContainerEntry {
  readonly kind: "container";
  readonly key: string;
  /** The element that holds the children (carries the layout style). */
  readonly body: HTMLElement;
  /** What sits in the parent: `body`, or the `<section aria-label>` wrapping `<h2>` and `body`. */
  outer: HTMLElement;
  heading: HTMLElement | undefined;
  layout: Layout;
  children: Entry[];
}
export type Entry = WidgetEntry | ContainerEntry;

const elementOf = (e: Entry): HTMLElement => (e.kind === "widget" ? e.host : e.outer);

// ── Widget frame: the canonical binding-status matrix ─────────────────────────

/** Draw a widget; any failure (a throwing `check`, a malformed `source`) becomes the error placeholder, never the message. */
function drawWidget(e: WidgetEntry, ctx: Ctx): void {
  try {
    drawWidgetUnsafe(e, ctx);
  } catch {
    for (const a of [
      "data-binding-state",
      "data-source-type",
      "data-source-version",
      "data-degraded",
      "title",
    ])
      e.host.removeAttribute(a);
    e.host.replaceChildren(placeholder(ctx, "error", e.widget.kind));
  }
}

function drawWidgetUnsafe(e: WidgetEntry, ctx: Ctx): void {
  const { widget, value, status } = e;
  const doc = ctx.doc;
  // The decision is shared with the React and terminal renderers (`describeWidgetStatus`); this
  // file owns only the markup. A malformed widget throws into `drawWidget`'s error placeholder.
  const d = describeWidgetStatus(widget, value, status, ctx.check);
  if (d.tag === "invalid") throw new TypeError(`renderer-dom: ${d.reason}`);
  if (d.tag === "redacted") {
    // IR 2.5.0: withheld for the surface's audience. Only the constant marker is drawn; no body,
    // no title, and no source/degraded attributes (the original type may itself be sensitive).
    for (const a of ["data-source-type", "data-source-version", "data-degraded", "title"])
      e.host.removeAttribute(a);
    e.host.replaceChildren(
      h(doc, "div", { "data-binding-marker": "redacted", role: "status" }, `⊘ ${d.message}`)
    );
    e.host.setAttribute("data-binding-state", "redacted");
    return;
  }
  const state = d.tag === "inert" ? undefined : d.tag;
  const label = widget.title ?? widget.kind;

  const children: Node[] = [];
  const marker = (tag: string, name: string, text: string, attrs: Record<string, string> = {}) =>
    children.push(h(doc, tag, { "data-binding-marker": name, ...attrs }, text));
  if (state === "error") marker("div", "error", `✗ ${label}: ${d.message}`, { role: "alert" });
  if (state === "empty") marker("div", "empty", `○ ${label}: ${d.message}`, { role: "status" });
  if (state === "stale" && value === undefined)
    marker("div", "stale", `~ ${label}: ${d.message} — no value`);
  if (state === "stale" && value !== undefined)
    children.push(h(doc, "span", { "data-binding-marker": "stale", title: d.finding }, "~"));
  if (state === "pending") marker("span", "pending", "⋯");
  if (state === "loading") marker("div", "loading", "…");

  if (d.showBody) children.push(drawBody(e, ctx));
  e.host.replaceChildren(...children);

  const set = (name: string, v: string | undefined) =>
    v === undefined ? e.host.removeAttribute(name) : e.host.setAttribute(name, v);
  set("data-binding-state", state);
  set("data-source-type", widget.source?.type);
  set("data-source-version", widget.source?.version);
  const chain = d.degradedChain;
  set("data-degraded", chain);
  set(
    "title",
    chain
      ? `${widget.source?.type}@${widget.source?.version} shown as ${widget.kind} (degraded from ${chain})`
      : undefined
  );
}

function placeholder(ctx: Ctx, reason: "missing" | "error", kind: string): HTMLElement {
  return h(
    ctx.doc,
    "div",
    { "data-placeholder": reason },
    reason === "missing" ? `[No renderer for ${kind}]` : `[Renderer for ${kind} failed]`
  );
}

function drawBody(e: WidgetEntry, ctx: Ctx): HTMLElement {
  const renderer = ctx.registry.get(e.widget.kind);
  if (renderer === undefined) return placeholder(ctx, "missing", e.widget.kind);
  try {
    return renderer({
      doc: ctx.doc,
      widget: e.widget,
      value: e.value,
      ...(e.status !== undefined && { status: e.status }),
      // A disposed widget's late click is dropped, not delivered.
      ...(ctx.onAction && {
        onAction: (a: WidgetAction) => {
          if (e.alive) ctx.onAction?.({ ...a, widgetId: e.widget.id });
        },
      }),
    });
  } catch {
    // One widget's failure never takes the surface down — and its message is not shown.
    return placeholder(ctx, "error", e.widget.kind);
  }
}

// ── Index (projection → widgets) ──────────────────────────────────────────────

function index(e: WidgetEntry, ctx: Ctx): void {
  const pid = e.widget.binding?.projectionId;
  if (pid === undefined) return;
  const set = ctx.byProjection.get(pid) ?? new Set<WidgetEntry>();
  ctx.byProjection.set(pid, set);
  set.add(e);
}
function unindex(e: WidgetEntry, ctx: Ctx): void {
  const pid = e.widget.binding?.projectionId;
  if (pid === undefined) return;
  const set = ctx.byProjection.get(pid);
  set?.delete(e);
  if (set?.size === 0) ctx.byProjection.delete(pid);
}

/** Re-read a widget's value and status from the state map; re-draw only if either changed. */
export function refreshWidget(e: WidgetEntry, ctx: Ctx, force = false): void {
  const value = resolveWidgetValue(e.widget, ctx.stateMap);
  const status = resolveWidgetStatus(e.widget, ctx.stateMap);
  if (!force && deepEqual(value, e.value) && deepEqual(status, e.status)) return;
  e.value = value;
  e.status = status;
  drawWidget(e, ctx);
}

// ── Mount / patch / dispose ───────────────────────────────────────────────────

function mountWidget(widget: Widget, key: string, ctx: Ctx): WidgetEntry {
  const host = h(ctx.doc, "div", {
    "data-widget-id": widget.id,
    "data-widget-kind": widget.kind,
  });
  const e: WidgetEntry = {
    kind: "widget",
    key,
    host,
    widget,
    value: undefined,
    status: undefined,
    alive: true,
  };
  index(e, ctx);
  ctx.mounted.add(widget.id);
  refreshWidget(e, ctx, true);
  return e;
}

function patchWidget(e: WidgetEntry, widget: Widget, ctx: Ctx): void {
  const changed = !deepEqual(e.widget, widget);
  if (changed) {
    unindex(e, ctx);
    e.widget = widget;
    index(e, ctx);
    // A reused key (duplicate-id bump) can now hold a different id: keep the host's attributes true.
    e.host.setAttribute("data-widget-id", widget.id);
    e.host.setAttribute("data-widget-kind", widget.kind);
  }
  refreshWidget(e, ctx, changed);
}

function disposeEntry(e: Entry, ctx: Ctx): void {
  if (e.kind === "widget") {
    e.alive = false;
    unindex(e, ctx);
    ctx.disposed.add(e.widget.id);
    return;
  }
  for (const c of e.children) disposeEntry(c, ctx);
  e.children = [];
}

const isLayout = (n: unknown): n is Layout =>
  typeof n === "object" &&
  n !== null &&
  ((n as Layout).type === "grid" ||
    (n as Layout).type === "flex" ||
    (n as Layout).type === "stack") &&
  Array.isArray((n as Layout).children);

const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10_000 ? v : undefined;

function styleBody(body: HTMLElement, layout: Layout): void {
  const set = (prop: string, v: string) => {
    if (body.style.getPropertyValue(prop) !== v) {
      if (v === "") body.style.removeProperty(prop);
      else body.style.setProperty(prop, v);
    }
  };
  const gap = (layout as { gap?: unknown }).gap;
  set("gap", typeof gap === "number" && Number.isFinite(gap) && gap >= 0 ? `${gap}px` : "");
  if (layout.type === "grid") {
    set("display", "grid");
    set("grid-template-columns", `repeat(${posInt(layout.columns) ?? 1}, 1fr)`);
    set("flex-direction", "");
  } else {
    set("display", "flex");
    set("grid-template-columns", "");
    set("flex-direction", layout.type === "flex" && layout.direction === "row" ? "row" : "column");
  }
  body.setAttribute("data-layout", layout.type);
}

function chrome(c: ContainerEntry, ctx: Ctx): void {
  const title =
    typeof c.layout.title === "string" && c.layout.title !== "" ? c.layout.title : undefined;
  if (title === undefined) {
    if (c.outer !== c.body) {
      c.body.remove();
      c.outer = c.body;
      c.heading = undefined;
    }
    return;
  }
  if (c.outer === c.body) {
    c.heading = h(ctx.doc, "h2");
    c.outer = h(ctx.doc, "section", {}, c.heading, c.body);
  }
  // aria-label names the landmark; a <section>'s content does not (HTML-AAM).
  if (c.outer.getAttribute("aria-label") !== title) c.outer.setAttribute("aria-label", title);
  if (c.heading && c.heading.textContent !== title) c.heading.textContent = title;
}

interface Slot {
  node: Widget | Layout;
  span: number;
  row?: number;
  rowSpan?: number;
  column?: number;
}

function slotsOf(layout: Layout): Slot[] {
  if (layout.type === "grid") {
    return layout.children.map((raw) => {
      const c = asCell(raw);
      return {
        node: c.node,
        span: posInt(c.span) ?? 1,
        row: posInt(c.row),
        rowSpan: posInt(c.rowSpan),
        column: posInt(c.column),
      } as Slot;
    });
  }
  return layout.children.map((node) => ({ node, span: 1 }));
}

function placeSlot(el: HTMLElement, s: Slot | undefined): void {
  const set = (prop: string, v: string) => {
    if (el.style.getPropertyValue(prop) !== v) {
      if (v === "") el.style.removeProperty(prop);
      else el.style.setProperty(prop, v);
    }
  };
  const col =
    s?.column !== undefined
      ? `${s.column} / span ${s.span}`
      : s && s.span > 1
        ? `span ${s.span}`
        : "";
  const row =
    s?.row !== undefined
      ? `${s.row} / span ${s.rowSpan ?? 1}`
      : s?.rowSpan !== undefined
        ? `span ${s.rowSpan}`
        : "";
  set("grid-column", col);
  set("grid-row", row);
}

/** Land `layout`'s children on `c`, reusing every entry whose key still matches. */
function reconcileChildren(c: ContainerEntry, layout: Layout, ctx: Ctx): void {
  const old = new Map(c.children.map((e) => [e.key, e]));
  const next: Entry[] = [];
  const seen = new Map<string, number>();
  const usedKeys = new Set<string>();
  let ordinal = 0;
  const slots = slotsOf(layout);
  const placed: Array<Slot | undefined> = [];
  for (const slot of slots) {
    const node = slot.node;
    let base: string;
    if (isWidget(node)) base = `w:${node.id}`;
    else if (isLayout(node))
      base = isLayoutId((node as { id?: unknown }).id)
        ? `c:${(node as { id: string }).id}`
        : `c#${ordinal++}:${node.type}`;
    else continue; // malformed node: skipped, like the identity walk skips it
    // A duplicate id gets its own key and never aliases another: bump until the key is unused
    // (`a`,`a`,`a~1` must not both land on `w:a~1`), so every key in this pass is unique.
    let n = seen.get(base) ?? 0;
    let key = n === 0 ? base : `${base}~${n}`;
    while (usedKeys.has(key)) key = `${base}~${++n}`;
    seen.set(base, n + 1);
    usedKeys.add(key);

    const prior = old.get(key);
    let entry: Entry;
    if (isWidget(node)) {
      if (prior?.kind === "widget" && prior.widget.kind === node.kind) {
        old.delete(key);
        patchWidget(prior, node, ctx);
        entry = prior;
      } else entry = mountWidget(node, key, ctx);
    } else {
      const layoutNode = node as Layout;
      if (prior?.kind === "container" && prior.layout.type === layoutNode.type) {
        old.delete(key);
        patchContainer(prior, layoutNode, ctx);
        entry = prior;
      } else entry = mountContainer(layoutNode, key, ctx);
    }
    next.push(entry);
    placed.push(slot);
  }
  for (const gone of old.values()) disposeEntry(gone, ctx);
  c.children = next;

  // DOM order: touch a node only if it is not already in place, so focus and scroll survive.
  const want = next.map(elementOf);
  const wanted = new Set<Node>(want);
  for (const child of [...c.body.childNodes]) if (!wanted.has(child)) c.body.removeChild(child);
  want.forEach((el, i) => {
    if (c.body.childNodes[i] !== el) c.body.insertBefore(el, c.body.childNodes[i] ?? null);
  });
  want.forEach((el, i) => placeSlot(el, layout.type === "grid" ? placed[i] : undefined));
}

function patchContainer(c: ContainerEntry, layout: Layout, ctx: Ctx): void {
  c.layout = layout;
  styleBody(c.body, layout);
  chrome(c, ctx);
  reconcileChildren(c, layout, ctx);
}

export function mountContainer(layout: Layout, key: string, ctx: Ctx): ContainerEntry {
  const body = h(ctx.doc, "div");
  const c: ContainerEntry = {
    kind: "container",
    key,
    body,
    outer: body,
    heading: undefined,
    layout,
    children: [],
  };
  styleBody(body, layout);
  chrome(c, ctx);
  reconcileChildren(c, layout, ctx);
  return c;
}

/**
 * Land `next` on the root: keep the root container when its type matches, else replace it. The
 * root's parent is `slot`; returns the root entry now in place.
 */
export function reconcileRoot(
  slot: HTMLElement,
  root: ContainerEntry | undefined,
  next: unknown,
  ctx: Ctx
): ContainerEntry | undefined {
  if (!isLayout(next)) {
    if (root) disposeEntry(root, ctx);
    slot.replaceChildren();
    return undefined;
  }
  let entry: ContainerEntry;
  if (root && root.layout.type === next.type) {
    patchContainer(root, next, ctx);
    entry = root;
  } else {
    if (root) disposeEntry(root, ctx);
    entry = mountContainer(next, "root", ctx);
  }
  if (slot.firstChild !== entry.outer || slot.childNodes.length !== 1)
    slot.replaceChildren(entry.outer);
  return entry;
}

export function disposeRoot(root: ContainerEntry | undefined, ctx: Ctx): void {
  if (root) disposeEntry(root, ctx);
}
