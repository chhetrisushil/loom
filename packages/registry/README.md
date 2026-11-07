# @loom/registry — agent registry

A small in-memory map of agent definitions and their cards, keyed by agent id. `AgentRegistry` stores an
`AgentDefinition` together with an optional `RegisteredAgentCard` (name, description, url, version,
streaming capability, skills), and `globalAgentRegistry` is a ready-made process-wide instance. Its main
caller is `@loom/plugin-a2a`: when you register a remote peer, you can pass a registry and the peer is
recorded there as an agent, so other code can list and look it up. It is a plain lookup table, not a
router, and it has no persistence. The `package.json` description says "workflow and tool registry", but
the code holds agents only.

```ts
import { agent$ } from "@loom/core";
import { AgentRegistry, globalAgentRegistry } from "@loom/registry";

const triage = agent$({
  id: "triage",
  name: "Triage agent",
  description: "Sorts incoming tickets",
  tools: [],
});

const registry = new AgentRegistry().register(triage, {
  name: "Triage agent",
  version: "1.0.0",
  skills: [{ id: "sort", name: "Sort tickets" }],
});

registry.has("triage"); // true
registry.get("triage")?.card?.version; // "1.0.0"
registry.ids(); // ["triage"]

// The process-wide instance, if you do not want to thread one through.
globalAgentRegistry.register(triage);
// An A2A peer registers itself here too: `await peer.registerInto(effectRuntime, registry)`.
```

## Surface

- **`AgentRegistry`:** `register(definition, card?)` (returns the registry, so calls chain), `get(id)`,
  `has(id)`, `all()` and `ids()`.
- **`globalAgentRegistry`:** one shared `AgentRegistry` for the process.
- **Types:** `RegisteredAgent` (`definition`, `card?`) and `RegisteredAgentCard`.

## Behaviour that surprises people

- **Registering an existing id replaces it**, definition and card both. There is no duplicate check.
- **The card type is structural.** It mirrors the A2A agent card but is declared locally, so this package
  depends only on `@loom/core` and `@loom/plugin-a2a` does not import it back; the A2A client sees the
  registry through a structural `PeerAgentRegistrar`.
- **State is per process.** The registry is not stored in the event log, so it is empty after a restart
  until your code registers again, and `globalAgentRegistry` is shared by everything in the process.
- **It is not the capability catalog.** Agents are looked up here by id. Intent routing and planning use
  [`@loom/capability`](../capability/README.md).

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loom/registry` — agent registry" under "Composition" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [plugins](../../docs/plugins.md) (the barrel re-exports the registry), [user guide, section 7: agents, tools and A2A](../../docs/user-guide.md#7-agents-tools--a2a).
- Source: `packages/registry/src`; re-exported from [`@loom/sdk`](../sdk/README.md).
