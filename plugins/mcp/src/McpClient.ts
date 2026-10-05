import { jsonSchemaHash, tool$ } from "@loom/core";
import type { ToolDefinition } from "@loom/core";
import type { EffectRuntime } from "@loom/effect-runtime";
import { ToolEffect } from "@loom/effect-runtime";
import { z } from "zod";
import {
  DEFAULT_MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_META_KEY,
  type MappedMcpTool,
  type McpCallToolResult,
  type McpResourceContents,
  type McpResourceDescriptor,
  type McpResultFidelity,
  type McpServerConfig,
  type McpTool,
} from "./types";
import { MCP_UI_EXTENSION_ID, MCP_UI_MIME_TYPE, toUiResource, uiMetaOf } from "./ui";
import type { McpUiResource } from "./ui";

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

/** Bound on server-controlled text interpolated into thrown errors (audit SEC-5). */
const MAX_ERROR_TEXT = 2048;

export class McpClient {
  private sessionId: string | undefined;
  private nextId = 1;
  /** The version the server actually chose at `initialize`; falls back to ours. */
  private negotiatedVersion: string | undefined;

  constructor(private readonly config: McpServerConfig) {}

  /**
   * A stable identity for the server this client targets, for per-tool grants
   * (`mcp.invoke:<id>/<tool>`): the hostname (no brackets), plus `_<port>` when the port is not
   * the scheme's default (so `localhost:3001` and `localhost:3002` are distinct). `:` and `/` are
   * never used as separators — they delimit the grant id.
   */
  get serverHost(): string | undefined {
    try {
      const u = new URL(this.config.url);
      const host = u.hostname.replace(/^\[|\]$/g, "").replace(/:/g, "_");
      return u.port === "" ? host : `${host}_${u.port}`;
    } catch {
      return undefined;
    }
  }

  /** The protocol version this client offers before any negotiation. */
  private get offeredVersion(): string {
    return this.config.protocolVersion ?? DEFAULT_MCP_PROTOCOL_VERSION;
  }

  /** The version in force — the server's choice once known, else ours. */
  get protocolVersion(): string {
    return this.negotiatedVersion ?? this.offeredVersion;
  }

  private async rpc<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const id = this.nextId++;
    // Every request declares its protocol version in `_meta`; on Streamable HTTP
    // the same value also rides the `MCP-Protocol-Version` header (below). A
    // handshake-era server ignores an unknown `_meta` key, so declaring both is
    // safe today and is what the stateless revisions require.
    const meta = { [MCP_PROTOCOL_VERSION_META_KEY]: this.protocolVersion };
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      id,
      params: { ...params, _meta: { ...(params?._meta as object), ...meta } },
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // Declared per-request on Streamable HTTP. Harmless to a handshake-era
      // server that ignores it; required by the stateless revisions.
      "mcp-protocol-version": this.protocolVersion,
      ...this.config.headers,
      // ADR 0063 — per-call credentials (principal/token → headers) ride the
      // transport only; they are supplied inside the effect and never logged.
      ...extraHeaders,
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
      // Audit SEC-5 — server-controlled response text flows into thrown errors
      // and (via STEP_FAILED) the durable log; bound it.
      throw new Error(
        `MCP HTTP error ${resp.status}: ${(await resp.text()).slice(0, MAX_ERROR_TEXT)}`
      );
    }

    const newSessionId = resp.headers.get("mcp-session-id");
    if (newSessionId !== null) {
      this.sessionId = newSessionId;
    }

    const data = (await resp.json()) as JsonRpcResponse<T>;
    if (data.error !== undefined) {
      throw new Error(
        `MCP RPC error ${data.error.code}: ${data.error.message.slice(0, MAX_ERROR_TEXT)}`
      );
    }
    if (data.result === undefined) {
      throw new Error(`MCP RPC returned no result for method "${method}"`);
    }
    return data.result;
  }

  /**
   * Handshake. Advertises support for the UI extension so a server can decide
   * whether to register UI-bearing tools at all (the extension requires servers
   * to check before doing so, and to provide a text-only fallback otherwise).
   *
   * Advertising is honest here: this client CARRIES UI resources for an
   * application to render, and declaring the capability is what makes a server
   * send them. It does not claim to be a rendering host.
   */
  async connect(): Promise<void> {
    const result = await this.rpc<{ protocolVersion?: string }>("initialize", {
      protocolVersion: this.offeredVersion,
      capabilities: {
        tools: {},
        extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: [MCP_UI_MIME_TYPE] } },
      },
      clientInfo: { name: "@loom/plugin-mcp", version: "0.0.1" },
    });
    // Negotiation, not assertion: adopt the server's choice for later requests.
    if (typeof result.protocolVersion === "string") {
      this.negotiatedVersion = result.protocolVersion;
    }
  }

  /**
   * Every tool the server offers, each mapped to a Loom `ToolDefinition` +
   * effect. `resultFidelity` governs what those effects yield — see
   * {@link McpResultFidelity}; the definitions and schema pins are unaffected.
   */
  async listTools(options: { resultFidelity?: McpResultFidelity } = {}): Promise<MappedMcpTool[]> {
    const result = await this.rpc<{ tools: McpTool[] }>("tools/list");
    const fidelity = options.resultFidelity ?? "value";
    return (result.tools ?? []).map((mcpTool) => this.mapTool(mcpTool, fidelity));
  }

  /**
   * Register every server tool as a Loom effect. Pass
   * `{ resultFidelity: "full" }` when results may carry a UI declaration or
   * non-text content that the default projection would discard.
   */
  async registerInto(
    effectRuntime: EffectRuntime,
    options: { resultFidelity?: McpResultFidelity } = {}
  ): Promise<ToolDefinition[]> {
    const mapped = await this.listTools(options);
    for (const { definition, effect } of mapped) {
      effectRuntime.register(definition.id, effect);
    }
    return mapped.map((m) => m.definition);
  }

  /**
   * The FULL `tools/call` result — `content` (every block, not just text),
   * `structuredContent`, `isError`, and `_meta`.
   *
   * Prefer this over {@link callTool} whenever the result may carry anything
   * beyond text: a UI declaration (`_meta.ui`), an image/audio/resource block,
   * or a machine-readable `structuredContent`. `callTool` is the convenience
   * projection of this, and projections lose things.
   */
  async callToolResult(
    name: string,
    input: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<McpCallToolResult> {
    const result = await this.rpc<McpCallToolResult>(
      "tools/call",
      { name, arguments: input as Record<string, unknown> },
      extraHeaders
    );
    // A server may legally omit `content` when it returns `structuredContent`;
    // normalise so callers can iterate without guarding.
    return { ...result, content: Array.isArray(result.content) ? result.content : [] };
  }

  /**
   * Convenience projection of {@link callToolResult} to a single value.
   *
   * Resolution order matters: `structuredContent` is the tool's machine-readable
   * result and wins when present; otherwise text blocks are joined and parsed as
   * JSON, falling back to the raw string. Non-text blocks are NOT representable
   * here — reach for `callToolResult` when they matter.
   *
   * An `isError: true` result THROWS. MCP reports tool failures in-band as a
   * successful JSON-RPC response with that flag, so returning it as a value
   * would turn every tool error into a plausible-looking success.
   */
  async callTool(
    name: string,
    input: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<unknown> {
    return projectToolResult(name, await this.callToolResult(name, input, extraHeaders));
  }

  // ── Resources ──────────────────────────────────────────────────────────────

  async listResources(): Promise<McpResourceDescriptor[]> {
    const result = await this.rpc<{ resources?: McpResourceDescriptor[] }>("resources/list");
    return result.resources ?? [];
  }

  /** Raw `resources/read`. Returns every contents entry the server sent. */
  async readResource(uri: string): Promise<McpResourceContents[]> {
    const result = await this.rpc<{ contents?: McpResourceContents[] }>("resources/read", { uri });
    return result.contents ?? [];
  }

  /**
   * Read a `ui://` resource and stamp it with provenance (URI + content hash).
   *
   * This CARRIES the app; it never renders it. The returned `contentHash` is the
   * pin: capture it at plan time and verify it before rendering, so a replay
   * cannot silently show different markup than the original run.
   *
   * Returns `undefined` when the server has no contents for the URI.
   */
  async readUiResource(uri: string): Promise<McpUiResource | undefined> {
    const contents = await this.readResource(uri);
    // Prefer the entry the caller actually asked for; a server may return
    // several (e.g. a directory-ish read) and matching by URI avoids adopting
    // a neighbouring resource's body under the requested URI's identity.
    const match = contents.find((c) => c.uri === uri) ?? contents[0];
    return match === undefined ? undefined : toUiResource(match);
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

  private mapTool(mcpTool: McpTool, fidelity: McpResultFidelity): MappedMcpTool {
    const definition = tool$({
      id: mcpTool.name,
      name: mcpTool.name,
      description: mcpTool.description ?? mcpTool.name,
      kind: "tool",
      inputSchema: z.unknown() as z.ZodType<unknown>,
      outputSchema: z.unknown() as z.ZodType<unknown>,
    });

    const effect = new ToolEffect(async (input: unknown) => {
      if (fidelity === "value") return this.callTool(mcpTool.name, input);
      const result = await this.callToolResult(mcpTool.name, input);
      throwIfToolError(mcpTool.name, result);
      return result;
    });
    const ui = uiMetaOf(mcpTool._meta);

    return {
      definition,
      effect,
      jsonInputSchema: mcpTool.inputSchema,
      // ADR 0063 — the canonical pin (one hashing implementation, @loom/core).
      schemaHash: jsonSchemaHash(mcpTool.inputSchema),
      ...(ui !== undefined && { ui }),
    };
  }
}

/**
 * The `callToolResult` → single-value projection, and the ONE place an in-band
 * `isError` becomes a throw.
 *
 * Split out of `callTool` because a caller that needs the full result for its
 * own reasons — `mcpInvoke$` reads `_meta.ui` off it — must not have to
 * re-implement either half. Two projections that mostly agree is how a
 * convenience path and a fidelity path silently diverge (the ADR 0063 D1
 * warning, in its result-shaped form).
 *
 * Resolution order: `structuredContent` wins when present; otherwise text
 * blocks are joined and JSON-parsed, falling back to the raw string. Non-text
 * blocks are not representable — that is what the full result is for.
 */
export function projectToolResult(name: string, result: McpCallToolResult): unknown {
  throwIfToolError(name, result);
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const textContent = textOf(result);
  try {
    return JSON.parse(textContent) as unknown;
  } catch {
    return textContent;
  }
}

/**
 * Throw on an in-band tool failure. MCP reports tool errors as a SUCCESSFUL
 * JSON-RPC response carrying `isError: true`, so a full-fidelity caller that
 * skips this check turns every tool error into a plausible-looking success —
 * the exact defect the ADR 0072 implementation pass fixed in `callTool`.
 * Exported because `callToolResult` is the documented path for anything beyond
 * text, and it hands back the flag rather than acting on it.
 */
export function throwIfToolError(name: string, result: McpCallToolResult): void {
  if (result.isError === true) {
    throw new Error(`MCP tool "${name}" failed: ${textOf(result).slice(0, MAX_ERROR_TEXT)}`);
  }
}

/** Join the text blocks of a result, ignoring blocks that carry no text. */
function textOf(result: McpCallToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}
