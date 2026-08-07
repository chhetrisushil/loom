// ── MCP Apps (SEP-1865) ingress awareness ────────────────────────────────────
//
// The `io.modelcontextprotocol/ui` extension lets a server publish a static HTML
// resource under the `ui://` scheme and link it from a tool via
// `_meta.ui.resourceUri`. A HOST then renders it in a sandboxed iframe bridged by
// JSON-RPC over postMessage.
//
// Loom is not that host, and deliberately does not become one (ADR 0072 D2):
// iframe sandboxing, CSP synthesis, permissions policy and the sandbox-proxy
// architecture are browser-application concerns where a mistake is an XSS or
// exfiltration hole, and the kernel has no browser. What belongs HERE is the
// plumbing — recognising that a tool carries a UI, fetching the declared
// resource, and carrying it with provenance (URI + content hash) so an
// application *can* render it. Carry, do not render.

import { fnv1a64 } from "@loom/core";
import type { McpCallToolResult, McpResourceContents } from "./types";

/** The extension identifier a host advertises support for at `initialize`. */
export const MCP_UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

/** The URI scheme reserved for UI resources. */
export const MCP_UI_SCHEME = "ui://";

/** The MIME type carrying an MCP App's HTML in the MVP. */
export const MCP_UI_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Which callers may see a tool. `"model"` = offered to the agent; `"app"` =
 * callable by a rendered View. A host MUST reject a View's `tools/call` for a
 * tool lacking `"app"` — the mirror of that rule is enforced server-side by
 * `@loom/plugin-mcp-app`. Default when undeclared is both.
 */
export type McpUiVisibility = "model" | "app";

/** CSP domains a host uses to build the iframe's Content-Security-Policy. */
export interface McpUiCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/** The `_meta.ui` block on a TOOL — links it to its UI resource. */
export interface McpUiToolMeta {
  resourceUri: string;
  visibility?: McpUiVisibility[];
}

/** The `_meta.ui` block on a RESOURCE — how a host must sandbox it. */
export interface McpUiResourceMeta {
  csp?: McpUiCsp;
  permissions?: {
    camera?: boolean;
    microphone?: boolean;
    geolocation?: boolean;
    clipboardWrite?: boolean;
  };
  domain?: string;
  prefersBorder?: boolean;
}

/**
 * A fetched UI resource, carried with provenance.
 *
 * `contentHash` is the load-bearing field. The extension's own security model is
 * pre-declaration — hosts prefetch and review templates before anything runs —
 * and loom's replay model needs the same guarantee for a different reason: a
 * replay that renders a DIFFERENT UI than the original run is a silent
 * correctness bug. Pinning the hash at plan time and verifying it at render time
 * is the ADR 0063 schema-pin discipline applied to markup.
 */
export interface McpUiResource {
  uri: string;
  mimeType: string | undefined;
  /** HTML for a text resource; undefined when the server sent `blob`. */
  text: string | undefined;
  /** base64 body for a binary resource. */
  blob: string | undefined;
  /** `fnv1a64:<hex16>` over the resource body — the pin (ADR 0063 discipline). */
  contentHash: string;
  meta: McpUiResourceMeta | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** True when `uri` is a UI resource reference. */
export function isUiResourceUri(uri: unknown): uri is string {
  return typeof uri === "string" && uri.startsWith(MCP_UI_SCHEME);
}

/**
 * The `ui` declaration on a `_meta` block, or `undefined`. Rejects a `ui` block
 * whose `resourceUri` is absent or not a `ui://` URI: a UI pointer to an
 * arbitrary scheme is exactly the confused-deputy fetch this must not perform.
 */
export function uiMetaOf(meta: unknown): McpUiToolMeta | undefined {
  const ui = asRecord(asRecord(meta)?.ui);
  if (ui === undefined || !isUiResourceUri(ui.resourceUri)) return undefined;

  const visibility = Array.isArray(ui.visibility)
    ? ui.visibility.filter((v): v is McpUiVisibility => v === "model" || v === "app")
    : undefined;

  return {
    resourceUri: ui.resourceUri,
    ...(visibility !== undefined && visibility.length > 0 && { visibility }),
  };
}

/** The `_meta.ui` sandboxing block on a fetched resource, if any. */
export function uiResourceMetaOf(meta: unknown): McpUiResourceMeta | undefined {
  const ui = asRecord(asRecord(meta)?.ui);
  if (ui === undefined) return undefined;
  const csp = asRecord(ui.csp) as McpUiCsp | undefined;
  const permissions = asRecord(ui.permissions) as McpUiResourceMeta["permissions"];
  return {
    ...(csp !== undefined && { csp }),
    ...(permissions !== undefined && { permissions }),
    ...(typeof ui.domain === "string" && { domain: ui.domain }),
    ...(typeof ui.prefersBorder === "boolean" && { prefersBorder: ui.prefersBorder }),
  };
}

/**
 * Whether a tool is callable by a rendered View. Undeclared visibility means
 * both audiences (the extension's default), so an undeclared tool IS
 * app-callable — which is why a serving implementation must declare explicitly
 * rather than rely on the default.
 */
export function isAppVisible(ui: McpUiToolMeta | undefined): boolean {
  if (ui?.visibility === undefined) return true;
  return ui.visibility.includes("app");
}

/** Whether a tool is offered to the model. */
export function isModelVisible(ui: McpUiToolMeta | undefined): boolean {
  if (ui?.visibility === undefined) return true;
  return ui.visibility.includes("model");
}

/**
 * A UI declaration attached to a tool RESULT (rather than the tool itself), plus
 * any `ui://` resources embedded directly in the result's content blocks.
 * Returns `undefined` when the result carries no UI at all.
 */
export function uiFromResult(result: McpCallToolResult): {
  meta: McpUiToolMeta | undefined;
  embedded: McpResourceContents[];
} {
  const embedded = result.content
    .filter((block) => block.type === "resource")
    .map((block) => block.resource)
    .filter((r): r is McpResourceContents => r !== undefined && isUiResourceUri(r.uri));

  return { meta: uiMetaOf(result._meta), embedded };
}

/**
 * Hash a fetched resource body. Text hashes its characters; a binary resource
 * hashes its base64. The tag distinguishes them so a text body and a base64
 * body that happen to coincide never collide into the same pin.
 */
export function hashResourceBody(contents: McpResourceContents): string {
  return contents.text !== undefined
    ? fnv1a64(`text:${contents.text}`)
    : fnv1a64(`blob:${contents.blob ?? ""}`);
}

/** Build the carried, provenance-stamped view of a fetched resource. */
export function toUiResource(contents: McpResourceContents): McpUiResource {
  return {
    uri: contents.uri,
    mimeType: contents.mimeType,
    text: contents.text,
    blob: contents.blob,
    contentHash: `fnv1a64:${hashResourceBody(contents)}`,
    meta: uiResourceMetaOf(contents._meta),
  };
}
