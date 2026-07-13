---
marp: true
theme: default
paginate: true
title: "Loom — DB Command Center in Web Components"
---

<!-- _paginate: false -->

# DB Command Center — Web Components

### The *same* agentic command center, rendered with vanilla Web Components

**No React. No Angular. No framework.**
The entire agentic backend is reused verbatim — only the render layer changes.

`examples/db-command-center-wc`

<!--
Presenter: "This is the sharpest proof of Loom's bring-your-own-renderer claim.
If the backend truly doesn't care about the UI framework, we should be able to
delete React entirely and change nothing else. So we did."
-->

---

## The premise: BYOR, taken literally

Loom's renderer contract is framework-agnostic: `{ widget, value, onAction }`.

So the render layer should be **the only thing that changes** between UIs.

- React version → `@loom/plugin-renderer-react` (`BlueprintRenderer`, fiber)
- **This version → native Custom Elements**, ~150 lines of `src/dom/`

Everything upstream of the pixels is identical.

---

## Reused verbatim vs. new

**Reused, byte-for-byte** (all framework-agnostic):

`domain` · `runtime/*` · `agents/*` · `capabilities/*` (durable flows) · `a2a/*` (in-process A2A bus) · `orchestrator/*` · `blueprints/*` (the `blueprint$` definitions) · `widgets/customWidgets.ts` (`customWidget$` kinds)

**New — the Web Components render layer:**

| File | Role |
|---|---|
| `dom/elements.ts` | one Custom Element per widget kind (BYOC/BYOR on the platform) |
| `dom/BlueprintDom.ts` | the framework-agnostic BYOR core |
| `dom/latencyChart.ts` | native dynamic `import()` — code-splitting |
| `main.ts` | the vanilla shell (intent bar, tabs, approval banner) |

---

## The BYOR core — one function

```ts
// dom/BlueprintDom.ts
const tree = traverseBlueprint<HTMLElement>(blueprint.layout, EMPTY, {
  renderWidget({ widget }) {
    const node = document.createElement(KIND_TO_TAG[widget.kind]);
    const host = node as unknown as WidgetHost;
    host.setWidget(widget);

    const update = () => { host.value = resolveWidgetValue(widget, sliceOf(widget)); };
    update();
    const pid = widget.binding?.projectionId;
    if (pid) unsubs.push(runtime.subscribe(pid, executionId, update));   // ← granular
    return node;
  },
  renderContainer({ layout, children }) { /* a <div> with grid/flex/stack */ },
});
```

`traverseBlueprint<HTMLElement>` — the same walker the React and terminal renderers use.

---

## BYOC — a Custom Element per widget kind

```ts
class AgentTaskListElement extends WidgetElement {
  protected render(): void {
    const tasks = this.value as AgentTask[];
    /* build one <div class="task-row"> per task … */
  }
}
customElements.define("dcc-agent-task-list", AgentTaskListElement);
```

- A `.value` setter re-renders the element; the base class holds `widgetDef`.
- `RiskApproval` dispatches a **bubbling `widget-action` CustomEvent** → the app calls `orchestrator.resolveApproval`.
- Built-in kinds (e.g. `MetricCard`) get a platform renderer too — same registry idea, `KIND_TO_TAG`.

---

## "Fiber" — without a framework

React's fiber gave us granular updates, deferred streaming, and suspense. Reproduced on the platform:

- **Granular** — each element subscribes to **only its bound projection path** (`ProjectionRuntime.subscribe`) and updates just its own `.value`. One task row re-renders, never the tree — no reconciler.
- **Deferred streaming** — `InMemoryProjectionRuntime({ coalesceNotifications: true })` batches a burst of console lines into one notification per microtask.
- **Lazy / suspense** — `dcc-latency-chart` shows a placeholder, then native `import("./latencyChart")` swaps in the real chart. No sibling blanking.

> Same behavior. No virtual DOM. No framework runtime.

---

## Actions & the tab-independent approval

```ts
// element → bubbling event
this.dispatchEvent(new CustomEvent("widget-action", { bubbles: true, detail: { type, widgetId } }));

// BlueprintDom wires the root once
wrapper.addEventListener("widget-action", (e) => onAction(e.detail));

// main.ts drives the human-in-the-loop gate
projectionRuntime.subscribe("mission", MISSION_ID, renderApprovalBar);  // prominent banner
```

The approval banner is reachable from any tab — driven straight off the `mission` surface.

---

## The payoff — smaller and simpler

| | React version | Web Components version |
|---|---|---|
| Framework runtime | React + ReactDOM | **none** |
| Production bundle | ~366 kB | **~210 kB** |
| Lazy chart | `React.lazy` + `Suspense` | native `import()` → its own chunk |
| Granular updates | fiber + `useSyncExternalStore` | per-widget `subscribe` |
| Render layer LOC | renderers + registry | `dom/` (~3 files) |

Same features, ~40% smaller, zero framework dependency.

---

## The one non-obvious gotcha

A Custom Element class with `protected` members isn't cleanly assignable back to
`HTMLElement` under `exactOptionalPropertyTypes`.

**Fix:** drive elements through a small structural interface; keep the DOM tree
typed as plain `HTMLElement`.

```ts
export interface WidgetHost { setWidget(w: Widget): void; value: unknown; }
const host = document.createElement(tag) as unknown as WidgetHost;   // not `as WidgetElement`
```

Everything else is just the DOM.

---

## Run it & verify

```bash
pnpm --filter @loom/db-command-center-wc dev        # http://localhost:5173
```

Try the same two goals as the React app — identical behavior, identical agents,
identical durable suspend/resume and human-in-the-loop.

**Verified:** `tsc` + Biome clean, `vite build` OK (`latencyChart` splits its own
chunk), a jsdom render test drives custom elements → granular updates → approval →
resume-to-completion.

---

## Takeaway

> The agentic backend — intent, planner, capabilities, durable flows, the A2A
> bus, the orchestrator — **never knew it wasn't React.**

- BYOR isn't a slogan; it's a **swap of one directory**.
- The `blueprint$` + projection model renders anywhere `traverseBlueprint` can build a node: React, Angular, terminal, and now **the raw platform**.
- Fiber-grade UX is achievable with the platform's own primitives.

> Pairs with `db-command-center-deck.md` (the React original).
