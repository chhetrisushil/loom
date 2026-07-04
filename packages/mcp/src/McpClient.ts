import { z } from "zod";
import { tool$ } from "@loom/core";
import type { ToolDefinition } from "@loom/core";
import type { EffectRuntime } from "@loom/effect-runtime";
import { ToolEffect } from "@loom/effect-runtime";
import type { McpServerConfig, MappedMcpTool, McpTool } from "./types";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  id: number;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export class McpClient {
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(private readonly config: McpServerConfig) {}

  private async rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: "2.0", method, id, ...(params !== undefined && { params }) };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.config.headers,
    };
    if (this.sessionId !== undefined) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const resp = await fetch(this.config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`MCP HTTP error ${resp.status}: ${await resp.text()}`);
    }

    const newSessionId = resp.headers.get("mcp-session-id");
    if (newSessionId !== null) {
      this.sessionId = newSessionId;
    }

    const data = (await resp.json()) as JsonRpcResponse<T>;
    if (data.error !== undefined) {
      throw new Error(`MCP RPC error ${data.error.code}: ${data.error.message}`);
    }
    if (data.result === undefined) {
      throw new Error(`MCP RPC returned no result for method "${method}"`);
    }
    return data.result;
  }

  async connect(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "@loom/mcp", version: "0.0.1" },
    });
  }

  async listTools(): Promise<MappedMcpTool[]> {
    const result = await this.rpc<{ tools: McpTool[] }>("tools/list");
    return (result.tools ?? []).map((mcpTool) => this.mapTool(mcpTool));
  }

  async registerInto(effectRuntime: EffectRuntime): Promise<ToolDefinition[]> {
    const mapped = await this.listTools();
    for (const { definition, effect } of mapped) {
      effectRuntime.register(definition.id, effect);
    }
    return mapped.map((m) => m.definition);
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    const result = await this.rpc<{ content: Array<{ type: string; text?: string }> }>(
      "tools/call",
      { name, arguments: input as Record<string, unknown> }
    );
    const textContent = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    try {
      return JSON.parse(textContent) as unknown;
    } catch {
      return textContent;
    }
  }

  async disconnect(): Promise<void> {
    if (this.sessionId !== undefined) {
      try {
        await fetch(this.config.url, {
          method: "DELETE",
          headers: { "mcp-session-id": this.sessionId },
        });
      } catch {
        // best-effort disconnect
      }
      this.sessionId = undefined;
    }
  }

  private mapTool(mcpTool: McpTool): MappedMcpTool {
    const definition = tool$({
      id: mcpTool.name,
      name: mcpTool.name,
      description: mcpTool.description ?? mcpTool.name,
      kind: "tool",
      inputSchema: z.unknown() as z.ZodType<unknown>,
      outputSchema: z.unknown() as z.ZodType<unknown>,
    });

    const effect = new ToolEffect((input: unknown) => this.callTool(mcpTool.name, input));

    return {
      definition,
      effect,
      jsonInputSchema: mcpTool.inputSchema,
    };
  }
}
