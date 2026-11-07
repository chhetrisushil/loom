import { handler$, step$ } from "@loom/core";
import type { StepDefinition } from "@loom/core";
import { z } from "zod";
import type { McpClient } from "./McpClient";
import type { McpResultFidelity } from "./types";

/**
 * A static step bound to one MCP tool.
 *
 * `resultFidelity: "full"` yields the whole `CallToolResult` instead of the
 * convenience projection — necessary whenever the result may carry an MCP Apps
 * declaration (`_meta.ui`), an embedded `ui://` resource, or non-text content,
 * none of which survive the projection. Default `"value"`, because the output
 * shape is a durable contract (see {@link McpResultFidelity}).
 *
 * `taintResults: true` wraps each result as untrusted, stamped `mcp:<serverHost>/<toolName>`, as
 * `registerMcpInvoke` does. Off by default because it changes the output shape.
 */
export function mcpTool$(
  client: McpClient,
  toolName: string,
  options: { resultFidelity?: McpResultFidelity; taintResults?: boolean } = {}
): StepDefinition<unknown, unknown> {
  const fidelity = options.resultFidelity ?? "value";
  return step$({
    id: toolName,
    name: toolName,
    inputSchema: z.unknown() as z.ZodType<unknown>,
    outputSchema: z.unknown() as z.ZodType<unknown>,
    handler: handler$((input: unknown) =>
      client.callAs(toolName, input, fidelity, options.taintResults === true)
    ),
  });
}
