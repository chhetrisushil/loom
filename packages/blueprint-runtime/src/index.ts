export { blueprint$ } from "./Blueprint";
export { grid, flex, stack } from "./layout";
export {
  MetricCard,
  Timeline,
  ApprovalCard,
  StatusBadge,
  ProgressBar,
  DataTable,
  AlertCard,
  StreamingText,
} from "./widgets";
export { customWidget$ } from "./customWidget";
export { BLUEPRINT_IR_SHAPE, BLUEPRINT_IR_VERSION } from "./irVersion";
export {
  validateBlueprint,
  defineWidgetCatalog,
  builtinCatalog,
  BUILTIN_CATALOG_ID,
} from "./catalog";
export { catalogCoverage } from "./coverage";
export { blueprintNodeIds, preservesBlueprintNodes, preservesNodes } from "./identity";
export { blueprintPins, checkBlueprintPins } from "./pins";
// Re-exported from @loom/core so a consumer of the blueprint spelling types its report
// from the package it already imports — `IdentityReport` does not send anyone elsewhere
// either. The comparison itself stays in core, where its other consumer can reach it.
export type { PinFinding, PinFindingCode, PinReport, VersionPins } from "@loom/core";
export { RendererRegistry } from "./RendererRegistry";
export { traverseBlueprint, resolveWidgetValue, resolvePath } from "./traverseBlueprint";
export { traverseBlueprintAsync } from "./traverseBlueprintAsync";
export type {
  AsyncTraversalOptions,
  IncrementalRenderer,
} from "./traverseBlueprintAsync";
export type {
  Blueprint,
  DataBinding,
  FlexLayout,
  GridLayout,
  Layout,
  StackLayout,
  Widget,
  WidgetKind,
  WidgetAction,
  WidgetRendererProps,
} from "./types";
export type { ContainerContext, BlueprintTraversalOptions } from "./traverseBlueprint";
export type {
  CatalogEntry,
  WidgetCatalog,
  BlueprintFinding,
  BlueprintFindingCode,
  BlueprintValidation,
} from "./catalog";
export type { CoverageReport } from "./coverage";
export type { IdentityFinding, IdentityReport } from "./identity";
