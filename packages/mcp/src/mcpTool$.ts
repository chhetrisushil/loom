import { z } from "zod";
import { handler$, step$ } from "@loom/core";
import type { StepDefinition } from "@loom/core";
import type { McpClient } from "./McpClient";

export function mcpTool$(client: McpClient, toolName: string): StepDefinition<unknown, unknown> {
  return step$({
    id: toolName,
    name: toolName,
    inputSchema: z.unknown() as z.ZodType<unknown>,
    outputSchema: z.unknown() as z.ZodType<unknown>,
    handler: handler$((input: unknown) => client.callTool(toolName, input)),
  });
}
