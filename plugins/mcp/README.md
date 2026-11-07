# @loom/plugin-mcp

A Model Context Protocol client and server for loom. The client reaches a remote MCP server over HTTP and
turns its tools into loom effects or steps; the server exposes your own tools (and, optionally, MCP Apps
UI resources) to any MCP host. Use it when a flow or agent needs third-party tools you do not write, or
when you want to publish loom-backed tools. Loom carries MCP Apps UI declarations with provenance but is
not an MCP Apps host and does not render them (ADR 0072).

```ts
import { EffectRuntime } from "@loom/effect-runtime";
import { McpClient, createMcpServer, mcpInvoke$, registerMcpInvoke } from "@loom/plugin-mcp";

// Client: one `mcp.invoke` effect fronts every tool; the tool name is run-time data.
const client = new McpClient({ transport: "http", url: "https://tools.example.com/mcp" });
const effects = new EffectRuntime();
registerMcpInvoke(client, effects, { server: "tools", taintResults: true });
export const callTool = mcpInvoke$("call-tool"); // input: { toolName, args?, expectedSchemaHash? }

// Server: expose your own tools. createMcpServer throws unless you authenticate or pass `insecure: true`.
const server = createMcpServer({
  port: 3001,
  serverInfo: { name: "demo", version: "0.0.1" },
  authorize: (req) => req.headers.authorization === `Bearer ${process.env.MCP_TOKEN}`,
  tools: [
    {
      name: "echo",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      handler: async (args) => args,
    },
  ],
});

export async function main() {
  await client.connect();
  await server.start();
}
```

## Surface

- **Client.** `McpClient` (`connect`, `listTools`, `callTool`, `callToolResult`, `registerInto`,
  resource reads); `mcpTool$` for a step bound to one tool.
- **Dynamic dispatch.** `registerMcpInvoke` and `mcpInvoke$` (one effect, any tool), with the typed
  failures `schemaDrift` and `toolNotFound`, the `MCP_DISPATCHED` event and `mcpDispatchIndex`.
- **Server.** `createMcpServer` with `McpServedTool` / `McpServedResource`; `servedEffect` serves a
  registered effect.
- **MCP Apps.** `uiMetaOf`, `uiFromResult`, `MCP_UI_OBSERVED` and a content-hash pin on the UI resource.

## Behaviour that surprises people

- **A tool's own failure arrives in band.** MCP reports `isError` as a successful reply. `callTool` and
  the mapped effects throw on it; `callToolResult` returns it for you to inspect.
- **Results are plain values unless you say otherwise.** `resultFidelity` defaults to `"value"`, since
  a step's output is a durable contract. Only `"full"` keeps `_meta` (where a UI declaration lives)
  and non-text content blocks.
- **Third-party text is not marked untrusted by default.** `registerMcpInvoke({ taintResults: true })`
  wraps results with an origin of `mcp:<server>/<tool>`, so `@loom/llm` refuses them in instruction
  positions and fences them in a user message. Off by default because the output becomes
  `{ __loomTainted, value }`. The effects from `McpClient.registerInto` and `mcpTool$` have no such option.
- **Server descriptions are withheld from the model** unless `listTools` is given `trustDescriptions`.
  Tool names outside `^[A-Za-z0-9_-]{1,64}$` are skipped with a warning (or `McpToolNamesSkippedError`
  with `strictToolNames`) unless `anyToolName: true`.
- **Credentials.** Prefer `principalToHeaders` over a per-call `authToken`. A string `authToken` is
  rejected unless `acceptResolvedTokens: true`, which asserts that `redactionMiddleware` is wired and
  callers pass a `secretRef`; otherwise STEP_STARTED would log the raw token.
- **Grants can name one tool.** `mcp.invoke:<server>/<tool>`; the bare `mcp.invoke` grant covers every
  tool. `server` defaults to the client URL's hostname and must not contain `/` or `:`.
- **A schema pin is only checked if you give one.** `expectedSchemaHash` is compared per call; omit it
  and nothing is verified. The tool list is cached for `toolsTtlMs` (60 s).
- **The server is loopback and authenticated by default.** It binds `127.0.0.1`, and
  `createMcpServer` throws with neither `authenticate` nor `authorize` unless `insecure: true`
  (which is refused in strict mode). Without `authorizeTool`, any authenticated caller may use every
  served tool. An app-originated call to a journaled tool is denied unless `authorizeAppJournaledCall`
  admits it, and `audienceOf` defaults to `"model"`.
- **A UI that cannot be fetched never fails the dispatch.** Fetching a declared `ui://` resource for a
  pin costs one extra read and is opt-in (`resolveUi`).

## See also

- API reference: section "`@loom/plugin-mcp` — Model Context Protocol (client + server)" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [plugins](../../docs/plugins.md),
  [isolation and untrusted content](../../docs/user-guide/isolation-and-untrusted-content.md).
- ADRs: [0063 dynamic dispatch](../../docs/adr/0063-mcp-dynamic-dispatch.md),
  [0072 MCP Apps placement](../../docs/adr/0072-mcp-apps-ui-extension-placement.md),
  [0085 untrusted content](../../docs/adr/0085-untrusted-content-integrity-axis.md),
  [0125 tool search](../../docs/adr/0125-tool-search.md).

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).
