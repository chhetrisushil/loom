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
  /**
   * ADR 0063 — the canonical fingerprint of `jsonInputSchema`
   * (`jsonSchemaHash`, `fnv1a64:<hex16>`). Pin it in a blueprint at plan time;
   * `mcpInvoke$` verifies it per call and fails typed (`schemaDrift`) on
   * mismatch. The SAME hashing implementation backs registry change detection.
   */
  schemaHash: string;
}
