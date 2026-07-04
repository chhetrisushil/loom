import type { ToolDefinition } from "@loom/core";
import type { ToolEffect } from "@loom/effect-runtime";

export interface McpServerConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MappedMcpTool {
  definition: ToolDefinition;
  effect: ToolEffect;
  jsonInputSchema: Record<string, unknown>;
}
