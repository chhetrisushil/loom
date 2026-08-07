export { McpClient } from "./McpClient";
export { createMcpServer, servedEffect } from "./McpServer";
export type {
  McpAudience,
  McpCallContext,
  McpServedResource,
  McpServedTool,
  McpServer,
  McpServerOptions,
} from "./McpServer";
export { mcpTool$ } from "./mcpTool$";
export {
  MCP_DISPATCHED,
  MCP_INVOKE_ERRORS,
  MCP_INVOKE_TOOL_ID,
  McpInvokeInput,
  SchemaDriftPayload,
  ToolNotFoundPayload,
  mcpDispatchIndex,
  mcpInvoke$,
  registerMcpInvoke,
} from "./mcpInvoke$";
export type {
  McpDispatchIndexState,
  McpInvokeInputValue,
  McpInvokeOptions,
} from "./mcpInvoke$";
export { DEFAULT_MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_META_KEY } from "./types";
export type {
  McpServerConfig,
  MappedMcpTool,
  McpTool,
  McpCallToolResult,
  McpContentBlock,
  McpResourceContents,
  McpResourceDescriptor,
} from "./types";

// MCP Apps (SEP-1865) ingress awareness — carry, never render (ADR 0072 D2/D3).
export {
  MCP_UI_EXTENSION_ID,
  MCP_UI_MIME_TYPE,
  MCP_UI_SCHEME,
  hashResourceBody,
  isAppVisible,
  isModelVisible,
  isUiResourceUri,
  toUiResource,
  uiFromResult,
  uiMetaOf,
  uiResourceMetaOf,
} from "./ui";
export type {
  McpUiCsp,
  McpUiResource,
  McpUiResourceMeta,
  McpUiToolMeta,
  McpUiVisibility,
} from "./ui";
