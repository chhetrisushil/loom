# @loomwork/capability — flows as intent-addressable capabilities

A capability is a flow wrapped with the metadata a caller needs to find it: an `id`, a natural-language
`intent`, `tags`, an input schema, and optional `version`, `dependencies` and `aliases`.
`CapabilityCatalog` holds them, keyword-searches them, registers their flows into a `WorkflowRuntime`, and
starts one by id, optionally behind an invoke authorizer. It is the menu that `@loomwork/intent` routes over
and `@loomwork/planner` composes plans from. Use it when something other than your own code (a user's words, a
planner, another agent) has to choose which flow to run.

```ts
import { z } from "zod";
import { CapabilityCatalog, capability$ } from "@loomwork/capability";
import { app, helloFlow } from "./config"; // your defineConfig result and a registered flow

const greet = capability$({
  id: "greet-user",
  intent: "Greet a person by name",
  tags: ["social"],
  aliases: ["say hello"],
  inputSchema: z.object({ name: z.string() }),
  flow: helloFlow,
});

const catalog = new CapabilityCatalog({
  // Decides who may INVOKE a capability; distinct from the effect protection ring.
  authorizer: { authorize: ({ principal }) => ({ allowed: principal === "ada", reason: "ada only" }) },
}).register(greet);

catalog.find("greet a person"); // [{ capability, score }], best first, offline

const handle = await catalog.invoke(app.runtime, "greet-user", { name: "Ada" }, { principal: "ada" });
await handle.waitForCompletion();
```

## Surface

- **`capability$(config)`** returns a `CapabilityDefinition`. `CapabilityConfig` has `id`, `name?`, `intent`,
  `tags?`, `inputSchema`, `flow`, `version?`, `dependencies?`, `acceptsTainted?` and `aliases?`.
- **`CapabilityCatalog`:** `register`, `get`, `all`, `ids`, `find(query)`, `resolve(id)` (transitive
  dependencies, dependency first), `registerInto(workflowRuntime)` and `invoke(runtime, id, input, { principal? })`.
- **Authorization.** `CapabilityInvokeAuthorizer` (a synchronous `authorize(request)` returning
  `{ allowed, reason? }`) and `CapabilityInvokeDeniedError`.

## Behaviour that surprises people

- **`find` is a substring match, not a word match.** It counts how many distinct query terms (at most 64)
  occur in `id`, `name`, `intent` and `tags` joined into one lowercase string. It does not search `aliases`.
- **No authorizer means every invoke is allowed.** The authorizer is synchronous.
- **`dependencies` are metadata.** `resolve` orders them and throws on a missing one or a cycle, but
  `invoke` starts only the capability you name.
- **`invoke` starts the flow with the input you pass.** Validation is whatever the flow's own
  `inputSchema` does; the capability's `inputSchema` is not applied there.
- **`acceptsTainted` is a promise.** By default a plan step that would pass a tainted value (ADR 0085)
  into a capability is refused. Setting it lets the wrapper through, and nothing re-taints the
  capability's output, so one that echoes the payload unwrapped loses the taint.
- **`registerInto` is only needed when the runtime does not already have the flows.** An app built with
  `defineConfig({ flows })` already registered them.

## Install

`npm install @loomwork/capability` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/capability` / `@loomwork/intent` / `@loomwork/planner`" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [user guide, section 8: intent, planner and memory](../../docs/user-guide.md#8-intent-planner--memory), [section 20: capabilities, versioning, dependencies and authorization](../../docs/user-guide.md#20-capabilities-versioning-dependencies--authorization).
- ADRs: [0123 planning depth](../../docs/adr/0123-planning-depth-plan-graphs-replanning-and-goals.md), [0085 untrusted content](../../docs/adr/0085-untrusted-content-integrity-axis.md), [0125 tool search](../../docs/adr/0125-tool-search.md) (`aliases`).
- Source: `packages/capability/src`. Routing: [`@loomwork/intent`](../intent/README.md); planning: [`@loomwork/planner`](../planner/README.md).
