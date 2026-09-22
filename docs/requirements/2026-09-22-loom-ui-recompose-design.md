# loom-ui slice 6a — keyed recompose in the Lit adapter

**Status:** design, approved in review on 2026-09-22 · **Scope:** loom-ui `renderer-lit` (the adapter and its widget contract), a reference example in loom-examples, no loom code change · **Depends on:** Blueprint IR 2.0.0 (loom `main` 2eccbd8, ADR 0097) and loom-ui `main` e0bc98d · **Roadmap:** `2026-09-22-blueprint-ir-2-design.md` §7 row "6a".

## 0. Decisions this design rests on

Made in review on 2026-09-22:

| Question | Decision |
|---|---|
| Where does the example's form come from? | **An app-registered custom kind.** The example registers `NoteInput` through loom's `customWidget$` and a Lit renderer with a real `<textarea>`. 6a adds no framework vocabulary; slice 9 decides the vocabulary. |
| How does an app hand the adapter a revised Blueprint? | **`handle.update(next)` on the existing mount.** `renderBlueprintDom` keeps returning a handle; the handle gains `update`. No new surface-controller object, no coupling of the adapter to `@loom-ui/hydration` (IR 2.0.0 just severed it). |
| How are nodes matched? | **Id-keyed reconcile per container, focus-aware** (approach A). Widgets by loom's widget id; containers by structural key. Not a whole-tree flat map (re-parents every widget, blurs focus), not a DOM morph (no keys, breaks on reorder, re-runs every renderer). |
| Where does this spec live? | loom `docs/requirements/`, beside the two earlier loom-ui designs. |

## 1. The problem

`renderBlueprintDom(host, blueprint, opts)` mounts once and can only `dispose()`. An app whose agent revises the experience (loom-ui's planner emits a new artifact; `HydrationController.load(next)` already recomposes hydration, keeping the handles both artifacts share) has no way to land the new Blueprint except tear down and mount again. That regenerates every widget: a `<textarea>` the user is typing into loses its text, caret and focus; a scrolled list snaps to the top; every widget flashes through its loading row even when its binding did not change. The IR-2 design's responsibility table (§4) assigns "patch application preserving focus, scroll, half-entered input" to each surface implementation, Lit first. This slice builds it and proves it with an example where an agent revision lands while the user types.

## 2. Contract

### 2.1 `DomRenderHandle.update`

```ts
export interface DomRenderHandle {
  readonly element: HTMLElement;
  /** Land a revised Blueprint on the live tree. Never throws. */
  update(next: Blueprint): RecomposeReport;
  dispose(): void;
}

export interface RecomposeReport {
  /** loom's `preservesBlueprintNodes(before, after)`: ok, dropped-node-id findings, added, compared. */
  readonly identity: IdentityReport;
  /** Widget ids that kept their id but changed kind, or whose renderer has no `patch`: disposed and mounted again. */
  readonly remounted: readonly string[];
  /** Widget ids whose binding changed and were re-subscribed (their first slice is pushed synchronously). */
  readonly rebound: readonly string[];
  /** Renderer failures during the update, each already shown as the widget's error placeholder. */
  readonly findings: readonly RecomposeFinding[];
}
export interface RecomposeFinding {
  readonly code: "patch-failed" | "mount-failed";
  readonly nodeId: string;
  readonly message: string;
}
```

`identity` is loom's report, unchanged: `ok`, `findings` (`dropped-node-id`, one per dropped widget id), `added`, `compared`. The adapter adds no second identity vocabulary; its own two finding codes live in `RecomposeReport.findings`, separate from loom's, so neither list's element type is widened.

Invariants, each pinned by a test:

- A widget whose id and kind are unchanged keeps its host element, its Lit element instance (`===` before and after), its projection subscription (when the binding is unchanged) and every piece of DOM state inside it: `<textarea>` value and selection, `document.activeElement`, `scrollTop` of a scrolled widget.
- `update` never throws. A renderer that throws from `patch` or from a fresh mount leaves that one widget on the existing error placeholder and the rest of the tree updated; the failure is in `findings`.
- `update` with a Blueprint whose `id`, `title` or `projections` differ is allowed: the title node, `data-blueprint-id` and the unregistered-projection placeholders are patched; the state map is rebuilt for the new projection list.
- `update` after `dispose` is a no-op returning a report with one `patch-failed` finding (`nodeId: ""`, message "disposed"). `dispose` after `update` disposes exactly the widgets alive at that moment (the disposer list is maintained, not appended to).
- The rendered tree after `update(next)` is DOM-shape-identical (tag, `data-*`, inline styles, order) to a fresh `renderBlueprintDom(host, next, opts)` — asserted by serialising both, so a reconcile bug cannot hide behind "it looked right".

### 2.2 `DomWidgetHandle.patch`

```ts
export interface DomWidgetHandle {
  update(value: unknown, status?: BindingStatus): void;
  /** The widget node changed (props, title, source, span…) but kept id and kind. Optional. */
  patch?(widget: Widget): void;
  dispose(): void;
}
```

`elementRenderer(tag)` implements `patch` by assigning the element's reactive `widget` property; `LuWidget` re-renders its template. A renderer without `patch` is remounted on any widget change, reported in `remounted`. An unchanged widget node (deep-equal by `isEqual` on the two `Widget` objects, excluding nothing) is not patched at all.

**Rule for widgets that hold user input:** user-entered state is DOM state. A renderer must not overwrite it on `patch`, and must not overwrite it on `update` unless the BOUND value changed. In Lit terms: bind an input's `.value` only from the bound value in a `willUpdate` that checks `changed.has("value")`, never from a template expression that re-runs on every render. The example's `NoteInput` renderer is the reference implementation; the AGENTS rule records it.

## 3. The keyed reconcile

`update(next)` runs `reconcileLayout(oldLayout, newLayout, containerEl)` from the root:

1. **Container key.** A container is matched by `type` (grid / flex / stack) at the same position in its parent. Same type → patch styles in place (`grid-template-columns`, `gap`, `flex-direction`); different type → the whole container is disposed and mounted fresh (its widgets appear in `remounted`), which is the honest answer for a layout that changed shape.
2. **Children by id.** Build `Map<widgetId, {host, handle, widget}>` from the container's current children (containers use a synthetic key `#<index>:<type>`). For each child of the new layout, in order:
   - **kept, same kind:** if the `Widget` object differs → `handle.patch(widget)` (or remount if the renderer has no `patch`); re-apply the cell span on the host (`gridColumn`, cleared when the span drops to 1 or the parent is no longer a grid); if `binding` differs → unsubscribe, subscribe the new selector and push the first slice synchronously (`rebound`).
   - **kept, different kind:** dispose, mount fresh with the same host position (`remounted`).
   - **new:** mount as today (`added`, from loom's report).
   - **container:** recurse.
3. **Removed** (in the old map, not in the new layout): dispose the handle, unsubscribe, remove the host (`dropped-node-id`, from loom's report).
4. **Order.** Compute the target child sequence. Let `pinned` be the kept child whose host contains `document.activeElement` (at most one). Walk the target sequence and `insertBefore` every node that is out of place, except `pinned`, which is never moved — its neighbours are moved around it. A node that is already in place is not touched (so an unchanged tree makes zero DOM mutations). Without a focused child this is the ordinary keyed reorder.
5. **Root.** Title and `data-blueprint-id` patched; the projection placeholders list rebuilt from the new `projections`.

Complexity: one pass per container, `O(children)` with a map; no renderer is re-run for an unchanged node. `sliceSelector` and `sliceIsEqual` are unchanged.

## 4. Hydration alignment

Nothing changes in `@loom-ui/hydration`. The app's recompose is two lines and is documented in the README:

```ts
controller.load(nextExperience);            // recompose: aborts/drops unbound handles, keeps shared ones
handle.update(compile(nextExperience, …).blueprint);
```

A widget whose handle is unchanged keeps its subscription and never flashes to loading; a widget whose handle changed is `rebound` and shows loom's loading row until the new handle delivers — exactly what the status matrix says.

## 5. Reference example — `experience-recompose` (loom-examples)

Headless, offline, happy-dom (as `renderer-lit`'s own tests). A scripted `Planner` (implements loom-ui's planner SPI, no model) composes an experience of three nodes: a `Note` (app semantic type → `NoteInput` custom kind, a Lit renderer with a `<textarea>`), a `Metric`, and a `Collection` (a scrollable list). The test:

1. mounts through `renderBlueprintDom` with `litRegistry.merge(appRegistry)`;
2. types into the textarea, moves the caret to the middle, scrolls the list, and leaves focus in the textarea;
3. asks the planner to revise ("add an alert above the note, move the metric below the list, show latency in seconds, drop the badge") and lands it with `controller.load(next)` + `handle.update(compile(next).blueprint)`;
4. asserts: the textarea's value, `selectionStart`/`selectionEnd` and `document.activeElement` are unchanged; the list's `scrollTop` is unchanged; the metric's element is the same node and now shows the new unit; the alert is the first child; `identity.findings` and `identity.added` list exactly the dropped and added ids and `remounted: []`; the serialised tree equals a fresh mount of the new Blueprint; `dispose()` is clean.

Two more tests: a revision that changes a node's kind remounts that node only (`remounted: [id]`, every other element `===`); an app renderer without `patch` is remounted and reported. The example's README states the two-line recompose recipe and the user-input rule.

## 6. Tests in loom-ui

`renderBlueprintDom.test.ts` gains the keyed-update matrix, one test per row: kept (no DOM mutation, same element), patched props, added at position, dropped, reordered with focus pinned (the focused textarea keeps focus and value while its siblings move), kind changed → one remount, binding changed → rebound with the first slice pushed, container style changed in place, container type changed → container remount, failing `patch` → error placeholder + finding, `update` after `dispose`, DOM-shape parity with a fresh mount for every row. `litRegistry.test.ts`: `elementRenderer(...).patch` assigns the reactive property and the element re-renders. `noHydration.test.ts` unchanged and still green (the adapter gains no hydration import).

## 7. Documentation and shipping

- **loom** (this PR): the spec; the IR-2 design's §4 table row "Patch application preserving focus…" gains "→ this spec" once loom-ui's PR merges.
- **loom-ui** PR: `renderBlueprintDom.update`, `DomWidgetHandle.patch`, tests, README "Recomposing" subsection with the two-line recipe, AGENTS rules: "a kept widget is never re-created — identity is the widget id, and a focused subtree never leaves the DOM"; "user-entered state is DOM state: a renderer overwrites an input only when the bound value changes".
- **loom-examples** PR: `examples/experience-recompose` + README row.
- Each `--rebase`, on the maintainer's word; loom-ui first, then loom-examples (it links `@loom-ui/*` from `../loom-ui`).

## 8. Non-goals

Scheduling and coalescing of revision bursts (slice 6b); progressive stages (6c); a React implementation (loom's React renderer reconciles by React key already; a parity test is 6b's accessibility-parity work); animating moves; preserving state across a kind change (a kind change is a different widget).

## 9. Acceptance

All of §2's invariants and §6's rows pass in loom-ui; the loom-examples test in §5 passes headlessly; `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` green in loom-ui; loom untouched beyond this document.
