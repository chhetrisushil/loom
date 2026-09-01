// @loom/plugin-a2ui — project Loom agent surfaces onto the Google A2UI
// (Agent-to-UI) wire protocol v1.0 so any A2UI-compliant client can render a
// Loom-driven UI. Egress + inbound actions + `callFunction` bidirectional RPC.

export { A2UI_VERSION, isAction, isFunctionResponse } from "./messages";
export type {
  A2UIServerMessage,
  A2UIClientMessage,
  ComponentInstance,
  CreateSurfacePayload,
  UpdateComponentsPayload,
  UpdateDataModelPayload,
  DeleteSurfacePayload,
  ActionPayload,
  CallFunctionPayload,
  FunctionResponsePayload,
} from "./messages";

export { dotPathToPointer, dotPathToParts } from "./pointer";

export {
  DEFAULT_CATALOG_ID,
  defaultCatalog,
  defineCatalog,
  defineFunction,
  bind,
  text,
  badge,
  column,
  row,
  list,
  button,
  jsonDebugView,
} from "./catalog";
export type {
  A2UICatalog,
  CatalogComponentSchema,
  CatalogFunctionSchema,
  Dynamic,
} from "./catalog";

export { A2UISurfaceBridge } from "./A2UISurfaceBridge";
export type { A2UISurfaceBridgeOptions } from "./A2UISurfaceBridge";

export { validateComponents, validateFunctionCall, describeFindings } from "./conformance";
export type {
  A2UIFinding,
  A2UIFindingCode,
  A2UIValidation,
  ValidateComponentsOptions,
} from "./conformance";

export { A2UI_CALL_FUNCTION_TOOL_ID, registerA2UICallFunction } from "./callFunction";
export type {
  A2UICallFunctionInput,
  A2UICallFunctionTransport,
} from "./callFunction";
