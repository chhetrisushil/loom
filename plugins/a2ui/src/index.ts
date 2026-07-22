// @loom/plugin-a2ui — project Loom agent surfaces onto the Google A2UI
// (Agent-to-UI) wire protocol v1.0 so any A2UI-compliant client can render a
// Loom-driven UI. Egress + inbound actions only, by design.

export { A2UI_VERSION, isAction } from "./messages";
export type {
  A2UIServerMessage,
  A2UIClientMessage,
  ComponentInstance,
  CreateSurfacePayload,
  UpdateComponentsPayload,
  UpdateDataModelPayload,
  DeleteSurfacePayload,
  ActionPayload,
} from "./messages";

export { dotPathToPointer, dotPathToParts } from "./pointer";

export {
  DEFAULT_CATALOG_ID,
  defaultCatalog,
  defineCatalog,
  bind,
  text,
  badge,
  column,
  row,
  list,
  button,
  jsonDebugView,
} from "./catalog";
export type { A2UICatalog, CatalogComponentSchema, Dynamic } from "./catalog";

export { A2UISurfaceBridge } from "./A2UISurfaceBridge";
export type { A2UISurfaceBridgeOptions } from "./A2UISurfaceBridge";
