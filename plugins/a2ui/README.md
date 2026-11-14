# @loomwork/plugin-a2ui — render a Loom agent surface in any A2UI client

Projects a Loom agent surface onto the Google A2UI (Agent-to-UI) wire protocol v1.0, so a client that
speaks A2UI can draw a Loom-driven UI. `A2UISurfaceBridge` turns an execution's surface patches into
`createSurface` and `updateDataModel` messages, normalizes a client's button action or function reply
for you to turn into a resume, and can ask the client to run a named function (`callFunction`). It
produces and consumes message objects; you provide the transport (SSE, WebSocket, and so on).

```ts
import { A2UISurfaceBridge, badge, bind, column, text } from "@loomwork/plugin-a2ui";
import type { EventEnvelope } from "@loomwork/core";

declare const executionId: string;
declare function send(messages: unknown[]): void;
declare function onClientMessage(handler: (m: Parameters<A2UISurfaceBridge["ingestAction"]>[0]) => void): void;
declare function subscribe(id: string, handler: (e: EventEnvelope) => void): void;

const view = [
  column("root", ["status", "score"]),
  badge("status", bind("/status")),
  text("score", bind("/stats/score")),
];
const bridge = new A2UISurfaceBridge({ executionId, components: view, redact: ["customer.email"] });

send(bridge.snapshot()); // createSurface, with the current data for a late joiner
subscribe(executionId, (event) => send(bridge.handleEvent(event))); // updateDataModel per patch

onClientMessage((message) => {
  const action = bridge.ingestAction(message); // null unless it is an action for this surface
  if (action?.action === "approve") {
    // resume your flow here, e.g. runtime.resume(executionId, { eventType: "TaskApproved", payload: { action } })
  }
});
```

## Surface

- **Bridge.** `A2UISurfaceBridge` with `snapshot`, `handleEvent`, `recompose`, `identityDiff`, `close`,
  `ingestAction`, `callFunction` and `ingestFunctionResponse`. Loom's delta patch ops are translated to
  A2UI's whole-value `updateDataModel`; `remove` becomes `null`.
- **Catalogue.** `defaultCatalog` (`DEFAULT_CATALOG_ID` `loom.core.v1`: Text, Column, Row, List, Badge,
  Button), `defineCatalog`, `defineFunction`, and the builders `text`, `badge`, `column`, `row`, `list`,
  `button`, `bind`, `jsonDebugView`.
- **Conformance.** `validateComponents`, `validateCatalog`, `validateFunctionCall` and `describeFindings`
  report structural problems such as a dangling child, a cycle or an off-catalogue component.
- **`callFunction` as an effect.** `registerA2UICallFunction(effects, transport)` registers
  `a2ui.callFunction` (`A2UI_CALL_FUNCTION_TOOL_ID`) for a flow to call through `ctx.execute`.

## Behaviour that surprises people

- **The catalogue is checked.** The constructor and `recompose` throw for a component tree the catalogue
  does not cover, and `callFunction` throws for a function it does not declare. Naming a `catalogId`
  without supplying the `catalog` is refused unless it is the default.
- **Redaction is opt-in.** `redact` lists surface dot-paths masked on egress; leave it out and nothing
  is masked.
- **`ingestAction` checks the message type and the surface id, nothing more.** It does not know who sent
  it, so authenticate the connection before you resume a flow from an action.
- **Pass `expectedCallId` to `ingestFunctionResponse`.** Without it only the surface is checked, so a
  client can send an unsolicited reply for any `callId`.
- **`callId` must be deterministic and unique per call site.** Never random. A function with side
  effects must deduplicate on it, because effects are at-least-once.
- **Scope.** Continuous two-way binding sync is out of scope; actions and function calls are explicit
  messages. The bridge adds no event types.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0069](../../docs/adr/0069-a2ui-egress-adapter.md) and
  [ADR 0070](../../docs/adr/0070-a2ui-callfunction-bidirectional-rpc.md): egress and `callFunction`.
- [ADR 0088](../../docs/adr/0088-blueprint-conformance.md): the structural checks.
- A runnable `callFunction` demo lives in the `loom-examples` repo (`a2ui-callfunction`, `a2ui-egress`).
- API reference: section "`@loomwork/plugin-a2ui` — A2UI (Agent-to-UI) adapter" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
