# ADR 0100 — Blueprint IR 2.3.0: the `empty` binding state

- Status: **Accepted — implemented** (2026-09-23)
- Date: 2026-09-23
- Implements: the loom half of loom-ui gap G5 (a dependent widget over an empty upstream shows
  "no data", never an error) — genUI migrating onto loom-ui, phase 2.
- Builds on: [ADR 0097](0097-blueprint-ir-2.md) (D2: the loom-owned binding-status channel and
  the canonical status matrix this ADR adds a row to), [ADR 0096](0096-blueprint-stable-rendering-ir.md)
  (the version pin, and D2's major/minor rule this bump follows),
  [ADR 0099](0099-blueprint-ir-layout-roles.md) (the previous minor bump, and the
  statically-decidable rule its `role-invalid` finding used).
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** `BLUEPRINT_IR_VERSION`
  2.2.0 → 2.3.0.

## Context

A widget can be bound to data derived from an upstream step: loom-ui's hydration templates an
argument such as `{{steps.latest_orders.output.orders[0].id}}`. When the upstream answers with
NO rows — the customer has no orders — the index walks off the end of an empty array, and today
that fails exactly like a misspelt path: the provider fails, and the binding's status is
`error`. The app cannot tell its user "there is nothing here" for a question whose subject is
absent; it can only say "something broke", and a repair loop may try to fix a path that was
never wrong.

The distinction is loom-ui's to DETECT (its template walker knows an index past the end of a
present array from a missing key), but it is loom's to CARRY: the status a renderer reads is
loom's `BindingStatus`, and ADR 0097 D2 made its matrix identical on every renderer. None of
`pending`/`ready`/`stale`/`error` means "delivered, and empty": `ready` with no value is the
LOADING row (ADR 0097 D2: "it has not arrived"), `error` is a failure, and `stale` is an old
value. So the state set grows by one.

## Decisions

### D1 — `BindingState` gains `"empty"`, carried by the existing status channel

`BindingState` becomes `"pending" | "ready" | "stale" | "error" | "empty"`. `empty` means:
**delivery succeeded, and the upstream answered with no subject to show.** It is not an error,
not a staleness and not a wait.

It lives exactly where every other state lives — `BindingStatus.state`, written at
`DataBinding.status.path` in the same projection state the value resolves from (ADR 0097 D2).
No new field, no second channel: `isBindingStatus` admits `empty` under the same structural
rules as the other four (optional numeric `seq`, optional `{ code, message }` finding), and
`resolveWidgetStatus` resolves it unchanged. The literal is exact and case-sensitive (`"Empty"`,
`"no-data"` are malformed, i.e. no status).

A producer SHOULD NOT write a value beside an `empty` status (loom-ui's hydration fold drops the
bound value when it publishes `empty`, so an earlier `ready` value never shows under "no data");
a reader ignores one if it does (D2). The optional `finding` carries the producer's reason —
loom-ui's is `upstream-empty` — and its `message` is shown as the row's text.

### D2 — The matrix gains an `empty` row, ranked right after `error`

The canonical matrix, engaged only for a binding that declares a status channel, is now:

1. `error` → the finding replaces the value (unchanged).
2. **`empty` → the "no data" row replaces the value.** The widget's own renderer never runs, and
   a value beside the status is ignored.
3. The caller's `check(widget, value)` slot (unchanged) — **skipped under `empty`** as under
   `error`: there is no value to check.
4. `stale`, `pending`, `ready`/absent (unchanged).

Rendering:

- **React** (`WidgetFrame`): `data-binding-state="empty"` on the frame, and a marker
  `<div role="status" data-binding-marker="empty">○ {title}: {finding.message ?? "no data"}</div>`.
- **Terminal** (`renderBlueprintToString`): `○ ${title}: ${finding.message ?? "no data"}`, on
  the registry and kind-blind paths alike.

`○` (an empty circle) is the glyph beside `⋯`/`~`/`✗`; `title` is `widget.title ?? widget.kind`
as in every other row. A channel-less widget still ignores any status in the state (ADR 0097 D2).

### D3 — Accessibility: announced politely, never as an alert

The React marker is a `role="status"` live region: a screen reader announces "no data" when it
appears, politely, without interrupting. It is deliberately **not** `role="alert"`, which the
error row uses — an empty answer is a result, not a failure. An explicit `role` on a `div` is
used rather than `<output>` (Biome's `useSemanticElements` suggestion), because `<output>` means
a calculation result and its implicit live-region support varies between screen readers. The
terminal row is plain text; the glyph and the words "no data" (or the finding's message) are the
whole signal.

### D4 — An older reader degrades to its loading/ready fallback, never to its error row

A reader built against 2.2.0 or earlier does not know `empty`: its `isBindingStatus` rejects
`{ state: "empty" }`, so `resolveWidgetStatus` returns `undefined` — ADR 0097 D2's "never
written, or malformed" case. Its matrix then shows:

- the **loading** row when there is no value — which is what a producer following D1 leaves
  (React `…`, terminal `⋯ <title>`);
- the value as **ready** if a producer wrongly left one.

Neither is the error row, and nothing throws. That is the safe direction: an older reader shows
"not arrived yet" for "arrived, and empty" — incomplete, never alarming, never a repair trigger.
Pinned by a terminal test that feeds a state this build does not know through the same path.

### D5 — `empty` is not an error, and triggers nothing

loom attaches no behaviour to `empty`: no finding in `validateBlueprint`, no event, no retry, no
drift. Neither renderer calls anything on it. Whatever a producer does on its side (loom-ui
excludes `empty` from caching, drift and repair) is that producer's contract; the IR only names
the state.

**No new `validateBlueprint` finding.** ADR 0099 D4 added `role-invalid` because a malformed role
is in the ARTIFACT and `validateBlueprint` is the only gate it passes. A binding status is not in
the artifact at all — the Blueprint carries only WHERE it lives (`binding.status.path`); the
state itself is written into projection state at run time, which `validateBlueprint` never sees.
There is nothing statically decidable to report. A malformed status at run time is already
handled: it resolves to `undefined` (ADR 0097 D2), never a throw.

### D6 — A minor bump, and 2.2.0 artifacts are read as they are

A new literal in a closed union that readers switch over is a shape change a consumer can
observe, so the manifest records it: `BLUEPRINT_IR_SHAPE.bindingStates` gains `empty`, and
`irVersion.test.ts` pins a fifth digest beside the frozen `1.0.0`, `2.0.0`, `2.1.0` and `2.2.0`
rows. It is [ADR 0096 D2](0096-blueprint-stable-rendering-ir.md#d2--the-shape-is-guarded-twice-because-each-guard-fails-a-different-way)'s
**minor** case — no field is added, removed or flipped, and D4 makes the new value safe for an
older reader — so `BLUEPRINT_IR_VERSION` becomes `2.3.0`. `IR_VERSIONS_READ_AS_IS` gains `2.2.0`,
so `validateBlueprint` knows 2.0.0–2.3.0 and `upgradeBlueprint` is identity on all four. Writers
(`blueprint$`) stamp `2.3.0` from here on. A new test asserts `isBindingStatus` admits exactly the
manifested states, so the runtime set cannot drift from the IR.

## Consequences

- `BLUEPRINT_IR_VERSION` is `"2.3.0"`. Every artifact written under 2.x is read as it is; only a
  PRODUCER that writes `empty` needs a 2.3.0-aware reader to get the "no data" row (D4 otherwise).
- Newly authored blueprints are stamped `2.3.0`, so re-composing content identical to an earlier
  2.2.0 emission yields a different content address; stored 2.x artifacts keep theirs.
- A consumer that switches exhaustively over `BindingState` sees a new case (a `tsc` error in a
  `Record<BindingState, …>` or a `never` check) — the intended signal.
- loom-ui's `packages/core/src/blueprintIr.test.ts` pins the IR version it compiles against
  (2.2.0 once its G2 work lands) and goes red when loom-ui bumps its `LOOM_REF` past this ADR. That is the intended signal: the same PR teaches loom-ui's
  hydration to publish `empty` (`upstream-empty`) and its Lit base to draw it.
- `KERNEL_ABI_VERSION` stays 1.1.0 and `EVENT_SCHEMA_VERSION` stays 1.18.0: a binding status is
  projection STATE, not an event. `@loom/spec` lists this ADR in `NOT_A_CAPABILITY`, for the same
  reason as 0096–0099: an IR contract and renderer behaviour, not a runtime subsystem to grade.
- The next minor bump adds `2.3.0` to `IR_VERSIONS_READ_AS_IS`.
