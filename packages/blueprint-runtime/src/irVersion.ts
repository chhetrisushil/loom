import type {
  BindingState,
  BindingStatus,
  Blueprint,
  DataBinding,
  FlexLayout,
  GridCell,
  GridLayout,
  Layout,
  StackLayout,
  Widget,
  WidgetKind,
  WidgetSource,
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
// What this guards: field presence, field optionality (a required↔optional flip fails the
// build), the WidgetKind literals, the layout `type` literals. What it does not: a field's type
// being narrowed or widened, nor a `readonly` change. A consumer's typecheck catches those.
//
// Adding a Layout variant means adding its field manifest here too; `Record<Layout["type"], true>`
// catches the variant, not its fields.

export const BLUEPRINT_IR_VERSION = "2.2.0";

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
/** Every key of T, each tagged by whether T declares it optional. `satisfies` rejects a missing key,
 *  an excess key, AND an optional↔required flip — the three shape changes a compile target can break on. */
type KeyShape<T> = {
  readonly [K in keyof T]-?: K extends OptionalKeys<T> ? "optional" : "required";
};

const WIDGET = {
  _tag: "required",
  id: "required",
  kind: "required",
  title: "optional",
  props: "required",
  binding: "optional",
  source: "optional",
} as const satisfies KeyShape<Widget>;

const DATA_BINDING = {
  projectionId: "required",
  path: "required",
  status: "optional",
  sensitivity: "optional",
} as const satisfies KeyShape<DataBinding>;

const BINDING_STATUS_REF = {
  path: "required",
} as const satisfies KeyShape<NonNullable<DataBinding["status"]>>;

const BINDING_STATUS = {
  state: "required",
  seq: "optional",
  finding: "optional",
} as const satisfies KeyShape<BindingStatus>;

// The NESTED shapes, manifested in their own right. `KeyShape<BindingStatus>` only records that
// `finding` exists and is optional — a key added to, removed from or flipped inside the finding
// (or a `degradedFrom` entry) is a change to the compile target that the parent manifest cannot
// see. A consumer reads `finding.code`/`d.type`, so those key sets are part of the contract.
const BINDING_FINDING = {
  code: "required",
  message: "required",
} as const satisfies KeyShape<NonNullable<BindingStatus["finding"]>>;

const WIDGET_SOURCE = {
  type: "required",
  version: "required",
  degradedFrom: "optional",
} as const satisfies KeyShape<WidgetSource>;

const DEGRADED_FROM = {
  type: "required",
  version: "required",
} as const satisfies KeyShape<NonNullable<WidgetSource["degradedFrom"]>[number]>;

const GRID_CELL = {
  span: "optional",
  row: "optional",
  rowSpan: "optional",
  column: "optional",
  node: "required",
} as const satisfies KeyShape<GridCell>;

const BINDING_STATES = {
  pending: true,
  ready: true,
  stale: true,
  error: true,
} as const satisfies Record<BindingState, true>;

const GRID_LAYOUT = {
  type: "required",
  columns: "required",
  gap: "optional",
  title: "optional",
  role: "optional",
  children: "required",
} as const satisfies KeyShape<GridLayout>;

const FLEX_LAYOUT = {
  type: "required",
  direction: "required",
  gap: "optional",
  title: "optional",
  role: "optional",
  children: "required",
} as const satisfies KeyShape<FlexLayout>;

const STACK_LAYOUT = {
  type: "required",
  gap: "optional",
  title: "optional",
  role: "optional",
  children: "required",
} as const satisfies KeyShape<StackLayout>;

const BLUEPRINT = {
  _tag: "required",
  irVersion: "optional",
  id: "required",
  title: "required",
  layout: "required",
  projections: "required",
  projectionVersions: "optional",
} as const satisfies KeyShape<Blueprint>;

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

// Field manifests emit `"<key>:<required|optional>"` so an optional↔required flip changes the
// digest even though the key set itself is unchanged. The two literal-union manifests (kinds,
// layout types) have no optionality to capture, so they stay plain key lists.
const keysOf = (manifest: Record<string, "required" | "optional">): readonly string[] =>
  Object.entries(manifest)
    .map(([key, shape]) => `${key}:${shape}`)
    .sort();

const plainKeysOf = (manifest: Record<string, true>): readonly string[] =>
  Object.keys(manifest).sort();

/**
 * The shape of the Blueprint IR at `BLUEPRINT_IR_VERSION`, as sorted key sets. Digest this
 * (`fnv1a64(canonicalJson(BLUEPRINT_IR_SHAPE))`) to compare two builds' IR without a type checker.
 */
export const BLUEPRINT_IR_SHAPE = {
  widget: keysOf(WIDGET),
  dataBinding: keysOf(DATA_BINDING),
  bindingStatusRef: keysOf(BINDING_STATUS_REF),
  bindingStatus: keysOf(BINDING_STATUS),
  bindingFinding: keysOf(BINDING_FINDING),
  widgetSource: keysOf(WIDGET_SOURCE),
  degradedFrom: keysOf(DEGRADED_FROM),
  gridCell: keysOf(GRID_CELL),
  gridLayout: keysOf(GRID_LAYOUT),
  flexLayout: keysOf(FLEX_LAYOUT),
  stackLayout: keysOf(STACK_LAYOUT),
  blueprint: keysOf(BLUEPRINT),
  widgetKinds: plainKeysOf(WIDGET_KINDS),
  layoutTypes: plainKeysOf(LAYOUT_TYPES),
  bindingStates: plainKeysOf(BINDING_STATES),
} as const;
