import type {
  Blueprint,
  DataBinding,
  FlexLayout,
  GridLayout,
  Layout,
  StackLayout,
  Widget,
  WidgetKind,
} from "./types";

// ── The Blueprint as a stable rendering IR (ADR 0096) ─────────────────────────
//
// A `Blueprint` used to be a value one app authored and one renderer drew. Once an external
// framework COMPILES to it, its shape is an interface others depend on, and a field added or
// renamed here is a breaking change in a repository nothing in this workspace builds.
//
// So the shape is declared twice, on purpose. The types below are the truth; the manifests are a
// second spelling that `tsc` checks against them exhaustively — `AllKeys<T>` makes every key
// required, and `satisfies` on an object literal rejects an excess key — so any change to
// `Widget`, `Layout` or `Blueprint` fails the build until the manifest agrees. `irVersion.test.ts`
// then pins a digest of the manifests to BLUEPRINT_IR_VERSION, so the manifest cannot change
// without the version changing either. Neither half is sufficient alone.
//
// What this guards: field presence, the WidgetKind literals, the layout `type` literals. What it
// does not: a field's type being narrowed or widened. A consumer's typecheck catches that.

export const BLUEPRINT_IR_VERSION = "1.0.0";

type AllKeys<T> = { readonly [K in keyof T]-?: true };

const WIDGET = {
  _tag: true,
  id: true,
  kind: true,
  title: true,
  props: true,
  binding: true,
} as const satisfies AllKeys<Widget>;

const DATA_BINDING = { projectionId: true, path: true } as const satisfies AllKeys<DataBinding>;

const GRID_LAYOUT = {
  type: true,
  columns: true,
  gap: true,
  children: true,
} as const satisfies AllKeys<GridLayout>;

const FLEX_LAYOUT = {
  type: true,
  direction: true,
  gap: true,
  children: true,
} as const satisfies AllKeys<FlexLayout>;

const STACK_LAYOUT = {
  type: true,
  gap: true,
  children: true,
} as const satisfies AllKeys<StackLayout>;

const BLUEPRINT = {
  _tag: true,
  id: true,
  title: true,
  layout: true,
  projections: true,
  projectionVersions: true,
} as const satisfies AllKeys<Blueprint>;

const WIDGET_KINDS = {
  MetricCard: true,
  Timeline: true,
  ApprovalCard: true,
  StatusBadge: true,
  ProgressBar: true,
  DataTable: true,
  AlertCard: true,
  StreamingText: true,
} as const satisfies Record<WidgetKind, true>;

const LAYOUT_TYPES = { grid: true, flex: true, stack: true } as const satisfies Record<
  Layout["type"],
  true
>;

const keysOf = (manifest: object): readonly string[] => Object.keys(manifest).sort();

/**
 * The shape of the Blueprint IR at `BLUEPRINT_IR_VERSION`, as sorted key sets. Digest this
 * (`fnv1a64(canonicalJson(BLUEPRINT_IR_SHAPE))`) to compare two builds' IR without a type checker.
 */
export const BLUEPRINT_IR_SHAPE = {
  widget: keysOf(WIDGET),
  dataBinding: keysOf(DATA_BINDING),
  gridLayout: keysOf(GRID_LAYOUT),
  flexLayout: keysOf(FLEX_LAYOUT),
  stackLayout: keysOf(STACK_LAYOUT),
  blueprint: keysOf(BLUEPRINT),
  widgetKinds: keysOf(WIDGET_KINDS),
  layoutTypes: keysOf(LAYOUT_TYPES),
} as const;
