# @loomwork/plugin-mcp-app — serve a Loom agent surface as an MCP App

Projects a Loom agent surface onto the MCP Apps extension (SEP-1865, `io.modelcontextprotocol/ui`), so
an MCP host that supports it can render a Loom-driven UI. It is the server half only. Loom serves one
static, content-pinned HTML template (`ui://loom/surface-host`) that renders a declarative A2UI
component tree, and a hidden cursor tool the rendered view polls for changes. Hosting the view, meaning
the iframe, its CSP and `postMessage`, is out of scope (ADR 0072). Use it with `createMcpServer` from
`@loomwork/plugin-mcp`.

```ts
import { column, text, bind } from "@loomwork/plugin-a2ui";
import { createMcpServer } from "@loomwork/plugin-mcp";
import { surfaceCursorTool, surfaceHostPin, surfaceHostResource } from "@loomwork/plugin-mcp-app";
import type { EventStore } from "@loomwork/event-runtime";

declare const eventStore: EventStore;

const view = [column("root", ["status"]), text("status", bind("/status"))];
const PINNED = surfaceHostPin(); // record this at plan time; a later change to the template then throws

export const server = createMcpServer({
  serverInfo: { name: "release-approval", version: "0.0.1" },
  authorize: (req) => req.headers.authorization === `Bearer ${process.env.MCP_TOKEN}`,
  resources: [surfaceHostResource({ pin: PINNED })], // verified before it is served
  tools: [
    surfaceCursorTool({
      store: eventStore,
      components: view,
      redact: [], // required; list surface paths to mask, or [] to say nothing needs it
      authorize: (executionId) => executionId.startsWith("release-"),
    }),
  ],
});
```

## Surface

- **Template.** `SURFACE_HOST_URI`, `SURFACE_HOST_MIME_TYPE`, `SURFACE_HOST_TEMPLATE`,
  `surfaceHostResource(options?)`, and the pin helpers `surfaceHostPin`, `verifySurfaceHostPin` and
  `TemplateDriftError`.
- **Payload.** `surfacePayload(events, { executionId, components, redact, ... })` folds `SURFACE_PATCH`
  events into `{ surfaceId, executionId, components, dataModel, sequence }`. It checks the component tree
  against the catalog (`defaultCatalog` unless you pass one) and throws on a tree that does not conform.
- **Cursor tool.** `surfaceCursorTool(options)` builds `loom_surface_since` (`SURFACE_CURSOR_TOOL`), which
  returns `{ changed: false }` or a complete payload.
- **Provenance.** `isStale(action, currentSequence, tolerance?)` and `SEEN_SEQUENCE_FIELD`.

## Behaviour that surprises people

- **`redact` has no default.** It is required on `surfacePayload` and `surfaceCursorTool` because the
  payload crosses into a rendered iframe. Masking applies on the way out; the fold keeps the true values.
- **The cursor tool reads any execution id unless you pass `authorize`.** The view is untrusted and ids
  can be guessed. A refused id gets the same "no surface" error as a missing one.
- **The view polls; there is no server push.** The extension has none, so the cursor answers with either
  `{ changed: false }` or the whole model, never a delta. A change costs a full fold of the log.
- **Pinning is opt-in.** Without `pin`, `surfaceHostResource` serves whatever template this build
  contains. The pin detects drift in the template; it does not make the template safe to run.
- **`isStale` treats a missing `seenSequence` as stale.** It supplies evidence only; whether a lag
  invalidates a decision is your policy.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0072](../../docs/adr/0072-mcp-apps-ui-extension-placement.md): placement and the host-role boundary.
- [ADR 0069](../../docs/adr/0069-a2ui-egress-adapter.md): the A2UI component model it reuses.
- API reference: section "`@loomwork/plugin-mcp-app` — MCP Apps (SEP-1865) egress" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
