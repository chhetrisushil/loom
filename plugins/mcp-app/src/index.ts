// @loom/plugin-mcp-app — project a Loom agent surface onto the MCP Apps
// extension (SEP-1865, `io.modelcontextprotocol/ui`) so any MCP host renders a
// Loom-driven UI.
//
// Egress only. The HOST role — sandboxed iframe construction, CSP synthesis,
// permissions policy, the sandbox-proxy architecture, theming, display modes —
// is deliberately out of scope (ADR 0072 D2): it is a browser-application
// concern where a mistake is an XSS or exfiltration hole, and loom has no
// browser. What lives here is the server half: one static content-pinned
// template, the declarative payload that feeds it, and the cursor tool that
// substitutes for the extension's missing server push.

export {
  SURFACE_HOST_MIME_TYPE,
  SURFACE_HOST_TEMPLATE,
  SURFACE_HOST_URI,
  TemplateDriftError,
  surfaceHostPin,
  verifySurfaceHostPin,
} from "./template";

export { surfacePayload } from "./surfaceBridge";
export type { SurfacePayload, SurfacePayloadOptions } from "./surfaceBridge";

export { SURFACE_CURSOR_TOOL, surfaceCursorTool } from "./surfaceCursor";
export type { SurfaceCursorInput, SurfaceCursorOptions } from "./surfaceCursor";

export { surfaceHostResource } from "./serve";
export type { SurfaceHostResourceOptions } from "./serve";
