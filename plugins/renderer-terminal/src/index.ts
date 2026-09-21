export { renderBlueprintToString, TerminalRenderer } from "./renderBlueprint";
export type { TerminalRenderOptions } from "./renderBlueprint";
export { defaultTerminalRegistry } from "./defaultRegistry";
export type { TerminalWidgetRenderer } from "./defaultRegistry";
// Re-export so callers can do: import { RendererRegistry } from "@loom/plugin-renderer-terminal"
export { RendererRegistry } from "@loom/blueprint-runtime";
