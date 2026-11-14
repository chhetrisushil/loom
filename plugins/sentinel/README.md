# @loomwork/plugin-sentinel — a perpetual agent as one declaration

A sentinel is an agent that wakes on a cron schedule, does a bounded piece of work, remembers
something for the next wake, and goes back to sleep. `sentinelPreset()` assembles the pieces for that
from existing packages and returns them as values you wire into `defineConfig`: a `schedule$`
definition, carry state from `@loomwork/plugin-durable-state`, claim-check middleware that stores large tool
results by reference, and a pin policy so runs that recorded findings survive cleanup. It adds no
runtime behaviour of its own (ADR 0043, ADR 0044), so each piece can be replaced independently.

```ts
import { defineConfig } from "@loomwork/app";
import { InMemoryTimerStore } from "@loomwork/event-runtime";
import { InMemoryContentStore } from "@loomwork/plugin-content";
import { InMemoryDurableStateStore } from "@loomwork/plugin-durable-state";
import { sentinelPreset } from "@loomwork/plugin-sentinel";
import { z } from "zod";

const preset = sentinelPreset({
  id: "db-sentinel", // the agent's identity; the schedule and its state key derive from it
  cron: "0 */6 * * *", // 5 fields, evaluated in UTC unless you pass timeZone
  state: { schema: z.object({ wakes: z.number() }) },
  stateStore: new InMemoryDurableStateStore(),
  contentStore: new InMemoryContentStore(),
});

export const app = defineConfig({
  storage: { kind: "memory" },
  timers: { store: new InMemoryTimerStore(), schedules: [preset.schedule] },
  execution: {
    effectMiddleware: preset.middleware,
    registerEffects: (effects) => preset.register(effects),
  },
});

// In the flow the schedule starts (`<id>-flow` unless you pass flowId):
//   const carried = await preset.state.load(ctx);
//   ... work, emitting FINDING_RECORDED events for anything worth keeping ...
//   await preset.state.save(ctx, { wakes: (carried.value?.wakes ?? 0) + 1 }, carried.revision);
```

## Surface

`sentinelPreset(config)` returns:

- `schedule`: the `schedule$` definition, for `timers.schedules`.
- `state`: a `sentinelState` handle with `load(ctx)`, `save(ctx, value, expectedRevision)` and `clear(ctx)`.
- `middleware`: claim-check middleware (default inline cap 16 KiB), for `execution.effectMiddleware`.
- `register(effects)`: registers the carry-state effects; register your own tools beside them.
- `pinnedEventTypes` (default `["FINDING_RECORDED"]`) and `pinPredicate(eventStore)`: runs that carry
  one of these events are reported as pinned, for retention and the content sweep.
- `occurrenceId(t)` and `occurrenceOf(executionId)`: the deterministic `<id>@<epochMs>` execution id.

Config also takes `flowId`, `timeZone`, `state.version` and `state.migrations`, `inlineCapBytes`,
`digests` and `onOffload` for the claim check.

## Behaviour that surprises people

- **Nothing fires without a timer store.** Schedules only run when `timers` is configured with a store;
  the preset only builds the definition.
- **You still write the flow.** The preset does not register a flow named `<id>-flow` for you.
- **The pin policy does nothing by itself.** Pass `pinnedEventTypes` to
  `durability.retention.pinnedEventTypes` and to `sweepUnpinnedContent`, or use `pinPredicate` for
  `durability.retention.pinned`, or the runs are not protected.
- **Carry state is compare-and-set.** One live occurrence per schedule is what makes a conflict a sign of
  misconfiguration rather than ordinary contention; a stale revision throws.

## Status / See also

`npm install @loomwork/plugin-sentinel` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

- [ADR 0051](../../docs/adr/0051-perpetual-agents-placement-schedule-remodel.md),
  [ADR 0053](../../docs/adr/0053-durable-state-plugin.md) and
  [ADR 0054](../../docs/adr/0054-claim-check-middleware.md): the schedule, carry state, claim check.
- The `db-sentinel` example in `loom-examples` is the same pattern written out piece by piece.
- API reference: section "`@loomwork/plugin-sentinel` — the perpetual-agent preset" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/plugins.md](../../docs/plugins.md), [docs/user-guide.md](../../docs/user-guide.md).
