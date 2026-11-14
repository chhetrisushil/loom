# @loomwork/intent — natural language to a capability

`IntentRuntime` takes a sentence and picks which capability in a [`CapabilityCatalog`](../capability/README.md)
fulfils it, then optionally starts that capability's flow. With no model configured it uses a deterministic
keyword matcher over the catalog, so it works offline. With a `reasoning` runtime (preferred) or a plain
`provider`, a model chooses instead. It is routing only: it does not plan multiple steps (that is
[`@loomwork/planner`](../planner/README.md)) and it does not run anything but the flow it picks.

```ts
import { z } from "zod";
import { CapabilityCatalog, capability$ } from "@loomwork/capability";
import { IntentRuntime } from "@loomwork/intent";
import { app, helloFlow } from "./config"; // your defineConfig result and a registered flow

const catalog = new CapabilityCatalog().register(
  capability$({
    id: "greet-user",
    intent: "Greet a person by name",
    inputSchema: z.object({ name: z.string() }),
    flow: helloFlow,
  })
);

// No model configured: a deterministic keyword matcher over the catalog, so this works offline.
const intent = new IntentRuntime({ catalog, workflowRuntime: app.runtime });

const { route, reason } = await intent.routeExplained("please greet a person");
console.log(route?.capability.id, route?.confidence, reason); // "greet-user" 1 "keyword-match"

// Route and start in one call; throws if nothing matches.
const handle = await intent.run("please greet a person", { name: "Ada" });
await handle.waitForCompletion();
```

## Surface

- **`new IntentRuntime({ catalog, reasoning?, provider?, workflowRuntime?, scheduler?, prompts? })`.**
- **`route(text)`** returns an `IntentRoute` (`capability`, `confidence`, `rationale?`) or `null`.
  `routeExplained(text)` returns `{ route, reason }`, with `reason` one of `model-routed`, `model-none`,
  `model-unparseable`, `model-ambiguous`, `keyword-match`, `keyword-no-match` or `empty-catalog`.
- **`run(text, input)`** routes, then calls `workflowRuntime.start` on the chosen capability's flow.
  It needs `workflowRuntime` and throws if no capability matches.
- **`prompts`** (`system`, `user`) overrides the router's English prompt text.

## Behaviour that surprises people

- **A model's answer is final.** When a model is configured, `NONE`, an unusable reply or one naming two or
  more capability ids returns `null`. There is no keyword fallback after a model has answered; the keyword
  matcher runs only when no model is configured. `routeExplained` tells you which case you hit.
- **A replacement `system` prompt must still ask for only a capability id or `NONE`.** The first
  whitespace-separated word of the reply is matched against the catalog, with surrounding quotes and
  punctuation tolerated (a `NONE` first word is final).
- **Keyword confidence is a share, not a probability.** It is the best match's score divided by the sum of
  all matches' scores, so a single match always reports 1.
- **Routing is not journaled.** `route` is a plain call; if you need a recorded, replayable choice inside
  a flow, route through a decision (`ctx.decide`) yourself.
- **`scheduler` only changes priority.** With one supplied, the model call runs at `Priority.Idle`; the
  routing result is unaffected.

## Install

`npm install @loomwork/intent` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/capability` / `@loomwork/intent` / `@loomwork/planner`" in [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [user guide, section 8: intent, planner and memory](../../docs/user-guide.md#8-intent-planner--memory).
- Source: `packages/intent/src`. Model routing: [`@loomwork/reasoning`](../reasoning/README.md).
