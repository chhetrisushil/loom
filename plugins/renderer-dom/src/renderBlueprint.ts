import {
  type Blueprint,
  type IdentityReport,
  type RendererRegistry,
  type WidgetAction,
  preservesBlueprintNodes,
} from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { type DomWidgetRenderer, defaultDomRegistry } from "./defaultRegistry";
import { h } from "./safeDom";
import {
  type ContainerEntry,
  type Ctx,
  type WidgetValueCheck,
  disposeRoot,
  reconcileRoot,
  refreshWidget,
} from "./tree";

export interface DomRenderOptions {
  /** Kind-aware renderers. Default `defaultDomRegistry`; an unregistered kind draws a visible placeholder. */
  registry?: RendererRegistry<DomWidgetRenderer>;
  /** Value-contract check, run between `error`/`empty` and `stale`, for widgets that declare a status channel only. */
  check?: WidgetValueCheck;
  /** Receives every action a widget emits (`{ type, widgetId, payload }`). */
  onAction?: (action: WidgetAction) => unknown;
  /** Whether the blueprint's title renders as the root `<h1>`. Default `"heading"`. */
  title?: "heading" | "none";
  /** The document that owns the created elements. Default: `host.ownerDocument`, else the global `document`. */
  document?: Document;
}

export interface MountOptions extends DomRenderOptions {
  projectionRuntime: ProjectionRuntime;
  executionId: string;
}

/** What `update(next)` did. */
export interface DomUpdateReport {
  /** loom's own report of which node ids the revision dropped or changed identity of. */
  readonly identity: IdentityReport;
  /** Widget ids that were present before and after but had to be disposed and mounted again (kind change, or moved to another container). */
  readonly remounted: readonly string[];
  /**
   * How the call ended. `updated`: landed normally. `recovered`: the in-place reconcile failed,
   * so the old tree was disposed and `next` was mounted fresh (no old content survives).
   * `failed`: even the fresh mount failed; the surface is empty. `busy`: re-entrant call, ignored.
   * `disposed`: the handle is disposed, ignored. Anything but `updated` carries `error`, and for
   * `recovered` / `failed` the `identity` is `ok: false` with no comparison to offer.
   */
  readonly outcome: "updated" | "recovered" | "failed" | "busy" | "disposed";
  readonly error?: string;
}

export interface DomHandle {
  readonly element: HTMLElement;
  /** Land a revised blueprint on the live tree: widgets keyed by id, containers by layout id. Never throws. */
  update(next: Blueprint): DomUpdateReport;
  dispose(): void;
}

function documentFor(explicit: Document | undefined, host?: Node): Document {
  const doc = explicit ?? host?.ownerDocument ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error("renderer-dom: no DOM available — pass `document` (e.g. from jsdom)");
  }
  return doc;
}

function makeCtx(doc: Document, stateMap: Map<string, unknown>, o: DomRenderOptions): Ctx {
  return {
    doc,
    registry: o.registry ?? defaultDomRegistry,
    ...(o.check && { check: o.check }),
    ...(o.onAction && { onAction: o.onAction }),
    stateMap,
    byProjection: new Map(),
    disposed: new Set(),
    mounted: new Set(),
  };
}

interface Surface {
  readonly element: HTMLElement;
  readonly ctx: Ctx;
  root: ContainerEntry | undefined;
  /** Dispose everything and empty the slot, so no old content survives. */
  reset(): void;
  /** Re-apply `blueprint` (title, unregistered-projection notes, tree) onto `element`. */
  apply(blueprint: Blueprint, unregistered: readonly string[]): void;
}

function createSurface(
  doc: Document,
  blueprint: Blueprint,
  stateMap: Map<string, unknown>,
  o: DomRenderOptions
): Surface {
  const ctx = makeCtx(doc, stateMap, o);
  const element = h(doc, "div");
  const heading = o.title === "none" ? undefined : h(doc, "h1");
  const notes = h(doc, "div", { "data-blueprint-notes": true });
  const slot = h(doc, "div", { "data-blueprint-root": true });
  element.append(...(heading ? [heading] : []), notes, slot);
  const surface: Surface = {
    element,
    ctx,
    root: undefined,
    reset() {
      disposeRoot(surface.root, ctx);
      surface.root = undefined;
      ctx.byProjection.clear();
      slot.replaceChildren();
    },
    apply(bp, unregistered) {
      element.setAttribute("data-blueprint-id", bp.id);
      if (heading && heading.textContent !== bp.title) heading.textContent = bp.title;
      notes.replaceChildren(
        ...unregistered.map((id) =>
          h(
            doc,
            "div",
            { "data-placeholder": "projection", "data-projection-id": id },
            `[Projection ${id} is not registered]`
          )
        )
      );
      surface.root = reconcileRoot(slot, surface.root, bp.layout, ctx);
    },
  };
  return surface;
}

/**
 * Render a blueprint to a DOM element, once, from a projection state map — the DOM sibling of
 * `renderBlueprintToString`. The element is not live; use {@link mountBlueprint} for that.
 */
export function renderBlueprintToDom(
  blueprint: Blueprint,
  stateMap: Map<string, unknown>,
  options: DomRenderOptions = {}
): HTMLElement {
  const surface = createSurface(documentFor(options.document), blueprint, stateMap, options);
  surface.apply(blueprint, []);
  return surface.element;
}

function readStates(
  blueprint: Blueprint,
  runtime: ProjectionRuntime,
  executionId: string,
  into: Map<string, unknown>
): string[] {
  const unregistered: string[] = [];
  into.clear();
  for (const id of blueprint.projections) {
    try {
      into.set(id, runtime.getState(id, executionId));
    } catch {
      // Declared but never registered: a visible note, not a thrown mount. The widget bound to
      // it renders with no value and lights up if the projection is registered later.
      into.set(id, undefined);
      unregistered.push(id);
    }
  }
  return unregistered;
}

/**
 * Mount a blueprint into `host` and keep it live: each bound projection is subscribed, and a
 * state change re-draws only the widgets bound to it whose value or status actually changed.
 * `update(next)` lands a revised blueprint without rebuilding what did not change.
 */
export function mountBlueprint(
  host: HTMLElement,
  blueprint: Blueprint,
  options: MountOptions
): DomHandle {
  const { projectionRuntime: runtime, executionId } = options;
  const doc = documentFor(options.document, host);
  const stateMap = new Map<string, unknown>();
  const surface = createSurface(doc, blueprint, stateMap, options);
  const subs = new Map<string, () => void>();
  let current = blueprint;
  let disposed = false;
  let updating = false;

  const sync = (bp: Blueprint) => {
    const want = new Set(bp.projections);
    for (const [id, off] of subs) {
      if (!want.has(id)) {
        off();
        subs.delete(id);
      }
    }
    for (const id of want) {
      if (subs.has(id)) continue;
      subs.set(
        id,
        runtime.subscribe(id, executionId, (state) => {
          if (disposed) return;
          stateMap.set(id, state);
          // A throw here would escape into the projection runtime and starve its other
          // subscribers; refreshWidget draws the error placeholder itself, this is the backstop.
          for (const w of [...(surface.ctx.byProjection.get(id) ?? [])]) {
            try {
              refreshWidget(w, surface.ctx);
            } catch {
              /* drawn as a placeholder or left as is; never thrown into the runtime */
            }
          }
        })
      );
    }
  };

  const unregistered = readStates(blueprint, runtime, executionId, stateMap);
  surface.apply(blueprint, unregistered);
  sync(blueprint);
  host.appendChild(surface.element);

  return {
    element: surface.element,
    update(next) {
      const empty: IdentityReport = { ok: true, findings: [], added: [], compared: 0 };
      const failedId: IdentityReport = { ok: false, findings: [], added: [], compared: 0 };
      if (disposed)
        return { identity: empty, remounted: [], outcome: "disposed", error: "handle is disposed" };
      if (updating)
        return {
          identity: empty,
          remounted: [],
          outcome: "busy",
          error: "update re-entered while another update was running",
        };
      updating = true;
      surface.ctx.disposed.clear();
      surface.ctx.mounted.clear();
      let outcome: DomUpdateReport["outcome"] = "updated";
      let error: string | undefined;
      let identity = empty;
      try {
        try {
          identity = preservesBlueprintNodes(current, next);
        } catch {
          // a malformed revision yields no comparison, not a throw
        }
        try {
          const missing = readStates(next, runtime, executionId, stateMap);
          surface.apply(next, missing);
        } catch {
          // Never keep the old surface under a report that looks like success: drop it and
          // mount `next` fresh (or leave the slot empty).
          outcome = "recovered";
          error = "reconcile failed; the surface was rebuilt from the revision";
          identity = failedId;
          try {
            surface.reset();
            surface.ctx.disposed.clear();
            surface.ctx.mounted.clear();
            surface.apply(next, readStates(next, runtime, executionId, stateMap));
          } catch {
            outcome = "failed";
            error = "reconcile and fresh mount failed; the surface is empty";
            try {
              surface.reset();
            } catch {
              /* nothing left to do */
            }
          }
        }
        try {
          sync(next);
        } catch {
          if (outcome === "updated") {
            outcome = "failed";
            error = "subscription sync failed";
            identity = failedId;
          }
        }
        current = next;
        const remounted = [...surface.ctx.disposed].filter((id) => surface.ctx.mounted.has(id));
        return { identity, remounted, outcome, ...(error !== undefined && { error }) };
      } finally {
        updating = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of subs.values()) off();
      subs.clear();
      disposeRoot(surface.root, surface.ctx);
      surface.element.remove();
    },
  };
}
