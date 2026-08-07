import * as http from "node:http";
import type { EffectMode } from "@loom/core";
import type { EffectRuntime } from "@loom/effect-runtime";
import {
  DEFAULT_MCP_PROTOCOL_VERSION,
  type McpCallToolResult,
  type McpResourceContents,
} from "./types";
import { MCP_UI_EXTENSION_ID, MCP_UI_MIME_TYPE, isAppVisible, isModelVisible } from "./ui";
import type { McpUiResourceMeta, McpUiToolMeta } from "./ui";

// ── The MCP server half ──────────────────────────────────────────────────────
//
// Loom already speaks A2A as a server (`createA2AServer`) and nothing else; this
// is the same shape for MCP, so loom flows can be consumed by any MCP host. It
// is the prerequisite the MCP Apps work sits on: the UI extension is a thin
// layer over a server, and without one there is nothing to attach it to.
//
// Deliberately transport-thin — it moves JSON-RPC bytes to handlers. What it
// DOES own are the two boundaries a served tool surface must not get wrong:
// audience (who may call what) and seam (journaled vs ambient).

/** Who a request is speaking for. See {@link McpServerOptions.audienceOf}. */
export type McpAudience = "model" | "app";

export interface McpCallContext {
  /** Which audience issued this call. */
  audience: McpAudience;
  /** The raw request, for deployment-specific principal extraction. */
  request: http.IncomingMessage;
}

export interface McpServedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /**
   * MCP Apps linkage — the `ui://` resource that renders this tool's result, and
   * which audiences may call it. Declare `visibility` explicitly: the extension's
   * default when absent is BOTH audiences, so silence is permissive.
   */
  ui?: McpUiToolMeta;
  /**
   * ADR 0073 — which side of the determinism boundary this tool sits on.
   * `"ambient"` = an enrichment read (pagination, drill-down, a surface refetch)
   * that must never append to the log; `"journaled"` = a call that produces a
   * durable fact. App-originated calls to a `journaled` tool are DENIED unless
   * {@link McpServerOptions.authorizeAppJournaledCall} admits them.
   */
  mode?: EffectMode;
  handler(args: unknown, ctx: McpCallContext): Promise<unknown>;
}

export interface McpServedResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  /** `_meta.ui` sandboxing hints a host uses to build the iframe CSP. */
  meta?: McpUiResourceMeta;
}

export interface McpServerOptions {
  tools?: readonly McpServedTool[];
  resources?: readonly McpServedResource[];
  port?: number;
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
  /**
   * Authenticate every request. Return `true` to allow. **When unset the server
   * is UNAUTHENTICATED**: any caller can list and invoke every served tool.
   * Supply your own scheme (shared secret, mTLS, …); the server supplies the gate.
   */
  authorize?: (req: http.IncomingMessage) => boolean | Promise<boolean>;
  /**
   * Decide which audience a request speaks for. The UI extension gives the
   * SERVER no in-band signal — the host is the party that knows whether a
   * `tools/call` came from the model or from a rendered View, and the host is
   * where the spec puts visibility enforcement. A deployment that wants the
   * server-side mirror must therefore provide the boundary itself (a distinct
   * path, port, or credential for the app channel).
   *
   * Defaults to `"model"`: absent an explicit boundary, nothing is treated as
   * app-originated, so app-only tools stay unreachable rather than silently open.
   */
  audienceOf?: (req: http.IncomingMessage) => McpAudience;
  /**
   * Admit an app-originated call to a `journaled` tool. Default: DENY.
   *
   * This is the "journaled vs ambient" boundary at the surface. A View can call
   * any tool the host proxies for it; enrichment reads are harmless, but a call
   * that appends to the log is a state transition requested by the *user's UI*,
   * not by the flow. It must therefore run under its own principal with its own
   * grants rather than inheriting the execution's authority — so it is denied
   * until a deployment says otherwise.
   */
  authorizeAppJournaledCall?: (
    tool: McpServedTool,
    req: http.IncomingMessage
  ) => boolean | Promise<boolean>;
}

export interface McpServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}

// Matches the A2A server / isolate broker cap: an unauthenticated caller must not
// be able to OOM the process by streaming an endless body in before parse.
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL = -32603;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on("data", (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", (err: Error) => reject(err));
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcResult(res: http.ServerResponse, id: JsonRpcRequest["id"], result: unknown): void {
  send(res, 200, { jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(
  res: http.ServerResponse,
  id: JsonRpcRequest["id"],
  code: number,
  message: string
): void {
  send(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** Normalise a handler's return into a `CallToolResult`. */
function toCallToolResult(value: unknown): McpCallToolResult {
  if (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as McpCallToolResult).content)
  ) {
    return value as McpCallToolResult;
  }
  // Structured results carry BOTH: `structuredContent` for machine consumers
  // (and for a View's `ui/notifications/tool-result`), plus a text block so a
  // host with no structured-output support still has the required fallback.
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const port = options.port ?? 3002;
  const protocolVersion = options.protocolVersion ?? DEFAULT_MCP_PROTOCOL_VERSION;
  const serverInfo = options.serverInfo ?? { name: "@loom/plugin-mcp", version: "0.0.1" };
  const audienceOf = options.audienceOf ?? ((): McpAudience => "model");

  const tools = new Map<string, McpServedTool>();
  for (const tool of options.tools ?? []) tools.set(tool.name, tool);
  const resources = new Map<string, McpServedResource>();
  for (const resource of options.resources ?? []) resources.set(resource.uri, resource);

  let resolvedUrl = `http://localhost:${port}`;

  function describeTool(tool: McpServedTool): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    if (tool.ui !== undefined) meta.ui = tool.ui;
    return {
      name: tool.name,
      ...(tool.description !== undefined && { description: tool.description }),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined && { outputSchema: tool.outputSchema }),
      ...(Object.keys(meta).length > 0 && { _meta: meta }),
    };
  }

  function describeResource(resource: McpServedResource): Record<string, unknown> {
    return {
      uri: resource.uri,
      ...(resource.name !== undefined && { name: resource.name }),
      ...(resource.description !== undefined && { description: resource.description }),
      ...(resource.mimeType !== undefined && { mimeType: resource.mimeType }),
      ...(resource.meta !== undefined && { _meta: { ui: resource.meta } }),
    };
  }

  async function handleRpc(
    body: JsonRpcRequest,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const { id, method, params } = body;
    if (typeof method !== "string") {
      rpcError(res, id, JSON_RPC_INVALID_REQUEST, "missing method");
      return;
    }
    const audience = audienceOf(req);

    switch (method) {
      case "initialize": {
        rpcResult(res, id, {
          protocolVersion,
          capabilities: {
            tools: {},
            resources: {},
            // Declares the UI extension so a client knows UI-bearing tools exist.
            extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: [MCP_UI_MIME_TYPE] } },
          },
          serverInfo,
        });
        return;
      }

      case "notifications/initialized": {
        rpcResult(res, id, {});
        return;
      }

      case "tools/list": {
        // Visibility is a LISTING boundary as well as a call boundary: a tool the
        // model must not see is one the model must not be told about.
        const visible = [...tools.values()].filter((tool) =>
          audience === "app" ? isAppVisible(tool.ui) : isModelVisible(tool.ui)
        );
        rpcResult(res, id, { tools: visible.map(describeTool) });
        return;
      }

      case "resources/list": {
        rpcResult(res, id, { resources: [...resources.values()].map(describeResource) });
        return;
      }

      case "resources/read": {
        const uri = params?.uri;
        if (typeof uri !== "string") {
          rpcError(res, id, JSON_RPC_INVALID_PARAMS, "params.uri must be a string");
          return;
        }
        const resource = resources.get(uri);
        if (resource === undefined) {
          rpcError(res, id, JSON_RPC_INVALID_PARAMS, `unknown resource: ${uri}`);
          return;
        }
        const contents: McpResourceContents = {
          uri: resource.uri,
          ...(resource.mimeType !== undefined && { mimeType: resource.mimeType }),
          ...(resource.text !== undefined && { text: resource.text }),
          ...(resource.blob !== undefined && { blob: resource.blob }),
          ...(resource.meta !== undefined && { _meta: { ui: resource.meta } }),
        };
        rpcResult(res, id, { contents: [contents] });
        return;
      }

      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string") {
          rpcError(res, id, JSON_RPC_INVALID_PARAMS, "params.name must be a string");
          return;
        }
        const tool = tools.get(name);
        // An audience-invisible tool is reported as unknown, not as forbidden:
        // a "you may not call that" reply confirms the tool exists.
        if (
          tool === undefined ||
          (audience === "app" ? !isAppVisible(tool.ui) : !isModelVisible(tool.ui))
        ) {
          rpcError(res, id, JSON_RPC_INVALID_PARAMS, `unknown tool: ${name}`);
          return;
        }

        // The journaled/ambient boundary. A View may freely issue enrichment
        // reads; a call that appends to the log is a state transition requested
        // by the user's UI and needs its own authority, so it is denied by
        // default rather than inheriting the execution's.
        if (audience === "app" && tool.mode === "journaled") {
          const allowed = (await options.authorizeAppJournaledCall?.(tool, req)) ?? false;
          if (!allowed) {
            rpcResult(res, id, {
              content: [
                {
                  type: "text",
                  text: `tool "${name}" is journaled and not authorized for app-originated calls`,
                },
              ],
              isError: true,
            });
            return;
          }
        }

        try {
          const value = await tool.handler(params?.arguments, { audience, request: req });
          rpcResult(res, id, toCallToolResult(value));
        } catch (err) {
          // A tool failure is an in-band result (isError), not a JSON-RPC error:
          // the CALL succeeded, the tool did not.
          rpcResult(res, id, {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          });
        }
        return;
      }

      default:
        rpcError(res, id, JSON_RPC_METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  }

  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse): void => {
    void (async () => {
      try {
        if (req.method !== "POST") {
          send(res, 405, { error: "method not allowed" });
          return;
        }
        if (options.authorize !== undefined && !(await options.authorize(req))) {
          send(res, 401, { error: "unauthorized" });
          return;
        }

        let body: JsonRpcRequest;
        try {
          body = (await parseBody(req)) as JsonRpcRequest;
        } catch {
          rpcError(res, null, JSON_RPC_PARSE_ERROR, "invalid JSON body");
          return;
        }
        if (typeof body !== "object" || body === null) {
          rpcError(res, null, JSON_RPC_INVALID_REQUEST, "body must be a JSON-RPC object");
          return;
        }
        await handleRpc(body, req, res);
      } catch (err) {
        rpcError(res, null, JSON_RPC_INTERNAL, String(err));
      }
    })();
  });

  return {
    get url() {
      return resolvedUrl;
    },
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(port, () => {
          const addr = server.address();
          if (addr !== null && typeof addr === "object") {
            resolvedUrl = `http://localhost:${addr.port}`;
          }
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err?: Error) => (err !== undefined ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Serve a registered effect as an MCP tool, routed by its declared seam:
 * `ambient` effects go through `invokeTransient` (zero durable footprint by
 * construction, ADR 0066) and anything else through the caller-supplied
 * journaled path.
 *
 * This is the payoff of the mode declaration: the routing is READ off the tool
 * rather than hand-wired per surface, so a new invocation surface cannot
 * accidentally journal an enrichment read.
 */
export function servedEffect(
  effectRuntime: EffectRuntime,
  toolId: string,
  spec: Omit<McpServedTool, "handler" | "name"> & {
    name?: string;
    /** Required for `journaled` tools — how a durable call is performed. */
    journaled?: (args: unknown, ctx: McpCallContext) => Promise<unknown>;
  }
): McpServedTool {
  const { journaled, ...rest } = spec;
  return {
    ...rest,
    name: spec.name ?? toolId,
    async handler(args: unknown, ctx: McpCallContext): Promise<unknown> {
      if (spec.mode === "ambient") {
        return effectRuntime.invokeTransient(toolId, args, { label: `mcp:${toolId}` });
      }
      if (journaled === undefined) {
        throw new Error(
          `served tool "${toolId}" is journaled but no journaled() path was supplied`
        );
      }
      return journaled(args, ctx);
    },
  };
}
