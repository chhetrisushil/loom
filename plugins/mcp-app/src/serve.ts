// ── Publishing the template as a served resource ─────────────────────────────

import type { McpServedResource } from "@loom/plugin-mcp";
import {
  SURFACE_HOST_MIME_TYPE,
  SURFACE_HOST_TEMPLATE,
  SURFACE_HOST_URI,
  verifySurfaceHostPin,
} from "./template";

export interface SurfaceHostResourceOptions {
  /**
   * The pin captured at plan time. When supplied it is VERIFIED before the
   * resource is published, and a mismatch throws `TemplateDriftError` rather
   * than silently serving different markup than the run was planned against.
   *
   * Omitting it is the unpinned mode: convenient in development, and exactly the
   * silent-drift hazard the pin exists to prevent in production.
   */
  pin?: string;
  /** Override the served URI (defaults to {@link SURFACE_HOST_URI}). */
  uri?: string;
  /**
   * CSP domains the host uses to build the iframe policy. The template itself
   * makes NO external requests, so the correct value for the stock template is
   * to declare nothing — the host then applies its restrictive default
   * (`default-src 'none'`), which is precisely what a self-contained template
   * wants. Declare domains only for a customised template that needs them.
   */
  connectDomains?: string[];
  resourceDomains?: string[];
}

/**
 * The surface-host template as an MCP resource, ready to hand to
 * `createMcpServer({ resources: [...] })`.
 */
export function surfaceHostResource(options: SurfaceHostResourceOptions = {}): McpServedResource {
  if (options.pin !== undefined) verifySurfaceHostPin(options.pin);

  const csp = {
    ...(options.connectDomains !== undefined && { connectDomains: options.connectDomains }),
    ...(options.resourceDomains !== undefined && { resourceDomains: options.resourceDomains }),
  };

  return {
    uri: options.uri ?? SURFACE_HOST_URI,
    name: "Loom surface host",
    description:
      "Renders a Loom agent surface from a declarative A2UI component tree. Static and content-pinned; ships no per-app code.",
    mimeType: SURFACE_HOST_MIME_TYPE,
    text: SURFACE_HOST_TEMPLATE,
    ...(Object.keys(csp).length > 0 && { meta: { csp } }),
  };
}
