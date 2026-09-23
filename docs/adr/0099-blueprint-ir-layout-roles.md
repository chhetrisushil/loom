# ADR 0099 — Blueprint IR 2.2.0: layout roles

- Status: **Accepted — implemented** (2026-09-23)
- Date: 2026-09-23
- Implements: Q1 and the loom half of Q6 of the loom-ui G2 design (a container-renderer seam
  for loom-ui's DOM adapter) — genUI migrating onto loom-ui, phase 2.
- Builds on: [ADR 0096](0096-blueprint-stable-rendering-ir.md) (the version pin, and D2's
  major/minor rule this bump follows), [ADR 0098](0098-blueprint-ir-placement-and-titles.md)
  (the previous minor bump, whose `title` rule this ADR's validation rule copies),
  [ADR 0094](0094-blueprint-node-identity.md) (node identity, which a role deliberately does
  not join).
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** `BLUEPRINT_IR_VERSION`
  2.1.0 → 2.2.0.

## Context

An app can give a WIDGET its own renderer — `Widget.kind` is an open `string` and a
`RendererRegistry` is keyed by it — but it cannot do the same for a CONTAINER: a stepped or
paginated section, a tab set, a collapsible group. Every `Layout` is drawn by the renderer
itself from its closed geometry (`grid`/`flex`/`stack`). loom-ui is adding a container-renderer
registry to its DOM adapter, and the registry needs a key the Blueprint carries.

Two ways to find a container without growing the IR were rejected in the G2 design, and both are
the side channels the standing ruling forbids:

- **Matching on `title`.** A title is localised display text: a locale switch would silently
  un-match the renderer.
- **Matching on an id.** A `Layout` has no id; inventing one here would be a second identity axis
  that `preservesBlueprintNodes` (ADR 0094) does not cover.

So the IR grows by the one field the need names.

## Decisions

### D1 — Every `Layout` gains an optional `role`

`GridLayout`, `FlexLayout` and `StackLayout` gain `role?: string`: the open, app-defined axis
for containers that `Widget.kind` is for widgets. `type` stays the closed GEOMETRY; `role` is the
presentation a renderer that knows it may give that geometry (`"stepped"`, `"tabbed"`,
`"collapsible"` — any name the app chooses). It is **never an ARIA role and never display
text**; a renderer that honours one writes it as data (loom-ui: `data-container-role`), not as
`role=`.

`grid`/`flex`/`stack` take `role?` and omit the key when it is absent, so an unroled layout's
content address is byte-identical to 2.1.0's. loom ships no role vocabulary; built-in names, if
any, belong to whichever framework ships the renderers for them.

### D2 — A role is a registry key, and has a key's shape

A well-formed role matches `/^[a-z][a-z0-9-]{0,63}$/`: a lowercase ASCII letter, then lowercase
letters, digits or hyphens, **1–64 characters**. The reasons:

- **Non-empty**, because an empty key is "no role" spelled differently.
- **Lowercase ASCII, no `_` or `.`**, so `__proto__`, `constructor` and friends can never be a
  role (a registry that is ever an object map cannot be poisoned through one), a role never needs
  escaping in a CSS attribute selector (`[data-container-role=stepped]`) or a log line, and two
  spellings of one name (`Stepped`/`stepped`) cannot silently select different renderers.
- **At most 64 characters**, because a role is a name, not a payload, and a model-composed
  artifact is data that must not be able to buy unbounded work in a lookup or a DOM attribute.
- **Hyphens anywhere after the first character** — trailing (`a-`) and doubled (`a--b`) are
  accepted. The rule is a key's alphabet and length, not a style guide; a stricter spelling
  would reject names that are harmless as keys. The pattern is anchored with no multiline flag,
  so a trailing newline (`"stepped\n"`) or any whitespace is rejected.

`isLayoutRole(value: unknown): value is string` is the one spelling of the rule, exported from
`@loom/blueprint-runtime` so a compiler's schema (loom-ui core) and a renderer's lookup (loom-ui's
DOM adapter) apply the same predicate and cannot drift apart.

A role that is **absent, malformed, or unknown to the renderer in use** draws the plain
container, exactly as it draws under 2.1.0. At RENDER time malformed and unknown are the same case
on purpose: a renderer never throws, and never half-honours a role. At VALIDATION time they are
not (D4).

### D3 — A role is part of a container's identity for keyed reconcile

A renderer that reconciles a recomposed Blueprint against what it has mounted keys containers by
**ordinal among container siblings + `type` + `role`**. A role change is therefore a remount of
that container — swept out and mounted fresh, its widgets reported as remounted — exactly like a
`type` change, because the chrome state a role's renderer holds (the current step, the open tab)
was built for that role and means nothing to another. Same role, same ordinal, same type: the
container is kept and its chrome state survives, the same rule as a widget's user-entered state.

This is a contract for renderers that key containers at all (loom-ui's DOM adapter). loom's React
renderer keys children positionally and ignores the role (D5), so nothing about its reconcile
changes. A role does **not** join node identity: `blueprintNodeIds`/`preservesBlueprintNodes`
remain widget-id sets, and a Layout still has no id. *(Amended by
[ADR 0101](0101-blueprint-ir-layout-ids.md): a Layout may now carry an optional `id`, which is
node identity and which `preservesBlueprintNodes` compares; a role still is not. loom's React
renderer no longer keys containers purely positionally: a container with a well-formed id is keyed
by it, and only one without an id keeps its index key. It still ignores the role.)*

### D4 — One new finding: `role-invalid`, at `warn`

loom has no Blueprint parser: `validateBlueprint` is the only gate a model-composed artifact
passes before a renderer sees it, so a malformed role that it did not report would pass silently
everywhere — the author would see a plain container and no reason why. That is the reasoning ADR
0098 used for `placement-out-of-range`, and it applies here.

`validateBlueprint` reports `role-invalid` once per layout whose `role` is present (not
`undefined`) and fails `isLayoutRole` — a non-string, empty, uppercase, whitespace, `_`/`.`, or
more than 64 characters. `nodeId` and `kind` are `"<layout>"` (a layout has no id). *(Amended by
[ADR 0101](0101-blueprint-ir-layout-ids.md) D3: `nodeId` is now the layout's id when it has a
well-formed one, and `"<layout>"` otherwise; `kind` stays `"<layout>"`.)* The message
echoes the role bounded to 64 characters plus its length, because the value is untrusted and can
be any size.

It is a **`warn`**, not an `error`: nothing is lost but the custom rendering — every renderer
draws the plain container, which is still the complete content — so `ok` stays `true`. A caller
that wants a malformed role to be a refusal treats the warning as one, or refuses it earlier in
its compiler's schema with `isLayoutRole`.

A **well-formed but unknown** role is **not** a finding. Whether some renderer has it registered
is a fact about the registry in use, which `validateBlueprint` does not see; a role unknown to one
renderer is another's chrome. The builders still validate nothing (as for every other field).

`title` keeps ADR 0098 D6's no-finding rule: a malformed title is display text that renders
nothing, while a malformed role is a key that silently selects nothing.

### D5 — loom's own renderers ignore it

- **React** (`renderReactContainer`): no container registry, so every role draws the plain
  container — DOM-identical to the same layout without a role. A React seam would mirror
  loom-ui's and is out of scope until something asks for it.
- **Terminal** (`renderBlueprintToString`): a role is an interaction hint, and a one-shot text
  surface has no interaction. Every child under the title, in reading order, is already the whole
  content, so output is byte-identical with or without a role.
- `traverseBlueprint` hands `renderContainer` the layout itself, role included, unchanged.

### D6 — A minor bump, and 2.1.0 artifacts are read as they are

The field is optional, which is [ADR 0096 D2](0096-blueprint-stable-rendering-ir.md#d2--the-shape-is-guarded-twice-because-each-guard-fails-a-different-way)'s
**minor** case: `BLUEPRINT_IR_VERSION` becomes `2.2.0`, `BLUEPRINT_IR_SHAPE` gains
`role:optional` on the three layout manifests, and `irVersion.test.ts` pins a fourth digest beside
the frozen `1.0.0`, `2.0.0` and `2.1.0` rows. `IR_VERSIONS_READ_AS_IS` gains `2.1.0` (the guard
added after ADR 0098 fails otherwise), so `validateBlueprint` knows 2.0.0, 2.1.0 and 2.2.0, and
`upgradeBlueprint` is identity on all three. Writers (`blueprint$`) stamp `2.2.0` from here on.

## Consequences

- `BLUEPRINT_IR_VERSION` is `"2.2.0"`. Every reader written against 2.1.0 keeps working: the new
  field is optional and absent on every existing artifact.
- Newly authored blueprints are stamped `2.2.0`, so re-composing content identical to an earlier
  2.1.0 emission yields a different content address; stored 2.0.0/2.1.0 artifacts keep theirs.
- loom-ui's `packages/core/src/blueprintIr.test.ts` pins `"2.1.0"` and goes red when loom-ui
  bumps its `LOOM_REF` past this ADR. That is the intended signal: the same PR teaches loom-ui's
  `compile` to emit `role` and adds the container-renderer seam that reads it.
- `BlueprintFindingCode` gains `role-invalid` (warn). A consumer that switches exhaustively over
  the codes sees a new case; one that gates on `ok` is unaffected.
- `@loom/blueprint-runtime` exports one new value, `isLayoutRole`. It is part of the IR contract,
  not vocabulary: it names no role.
- `KERNEL_ABI_VERSION` stays 1.1.0 and `EVENT_SCHEMA_VERSION` stays 1.18.0. `@loom/spec` lists
  this ADR in `NOT_A_CAPABILITY`, for the same reason as 0096–0098: an IR contract and renderer
  behaviour, not a runtime subsystem to grade.
- The next minor bump adds `2.2.0` to `IR_VERSIONS_READ_AS_IS`.
