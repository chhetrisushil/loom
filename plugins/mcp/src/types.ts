import type { ToolDefinition } from "@loom/core";
import type { ToolEffect } from "@loom/effect-runtime";
// Type-only cycle with ./ui (which imports the wire shapes from here) — erased
// at compile time, so no runtime import cycle exists.
import type { McpUiToolMeta } from "./ui";

/**
 * The last MCP revision that uses the `initialize` handshake. The 2026-07-28
 * revision is stateless — no `initialize`, no `Mcp-Session-Id` — and declares
 * the version per-request instead (`_meta["io.modelcontextprotocol/protocolVersion"]`
 * plus the `MCP-Protocol-Version` header on Streamable HTTP). This client still
 * speaks the handshake, which the current spec explicitly supports under
 * "Backward Compatibility with initialization-based versions", so it pins the
 * newest handshake-era revision rather than the 2024 one it used to hardcode.
 */
export const DEFAULT_MCP_PROTOCOL_VERSION = "2025-11-25";

/** The `_meta` key every request declares its protocol version under. */
export const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

export interface McpServerConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
  /**
   * Protocol version to offer at `initialize` and to declare on subsequent
   * requests. Defaults to {@link DEFAULT_MCP_PROTOCOL_VERSION}. The server's
   * chosen version (from the handshake result) supersedes this for the
   * `MCP-Protocol-Version` header — negotiation, not assertion.
   */
  protocolVersion?: string;
}

/**
 * What a step seam yields as its output.
 *
 * - `"value"` (default) — the convenience projection: `structuredContent`, else
 *   joined-and-parsed text. Everything else is dropped, including `_meta` and
 *   every non-text content block.
 * - `"full"` — the whole {@link McpCallToolResult}. Required to observe an MCP
 *   Apps declaration (`_meta.ui`), an embedded `ui://` resource, or image/audio
 *   content, since none of those are representable in the projection.
 *
 * `"value"` remains the default because the output shape is a contract: it is
 * what STEP_COMPLETED records, what downstream steps destructure, and what a
 * replay substitutes. Widening it by default would change every existing
 * consumer's payload silently.
 */
export type McpResultFidelity = "value" | "full";

// ── Tool results (MCP `CallToolResult`) ──────────────────────────────────────

/**
 * One block of a tool result's `content`. Text is the common case; `image`,
 * `audio`, and `resource` blocks carry `data`/`resource` instead — all of which
 * this client previously discarded on the way in.
 */
export interface McpContentBlock {
  type: string;
  text?: string;
  /** base64 payload for `image`/`audio` blocks. */
  data?: string;
  mimeType?: string;
  /** Embedded resource for `resource` blocks. */
  resource?: McpResourceContents;
  _meta?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * The full `tools/call` result. Everything here except `content` used to be
 * dropped by `callTool`, which flattened text blocks and JSON-parsed them —
 * `structuredContent` (the machine-readable result) and `_meta` (where the UI
 * extension hangs `ui.resourceUri`) never reached a caller.
 */
export interface McpCallToolResult {
  content: McpContentBlock[];
  /** The tool's machine-readable result, when it declares an output schema. */
  structuredContent?: unknown;
  /**
   * In-band tool failure. MCP reports tool errors as a SUCCESSFUL JSON-RPC
   * response with this flag set — a protocol-level error means the *call* failed,
   * not the tool. Ignoring it (as this client did) silently turns a failure into
   * a value.
   */
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

// ── Resources ────────────────────────────────────────────────────────────────

/** One resource's contents, as returned by `resources/read`. */
export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  /** Present for text resources (a `ui://` app's HTML arrives here). */
  text?: string;
  /** base64, present for binary resources. */
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

// ── Tools ────────────────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Where the UI extension declares `ui.resourceUri` / `ui.visibility`. */
  _meta?: Record<string, unknown>;
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
  /**
   * ADR 0072 Step 1 — the MCP Apps (`io.modelcontextprotocol/ui`) declaration
   * on this tool, when it carries one. Present means the server ships a `ui://`
   * app for this tool; absent means text-only. Carried, never rendered — the
   * host role (iframe, CSP, postMessage) is deliberately out of scope here.
   */
  ui?: McpUiToolMeta;
}
