# @loomwork/projection-runtime — in-memory read models folded from events

A projection folds an execution's events into a small state object that a UI or another reader can
query and subscribe to. This package holds the `Projection` and `ProjectionRuntime` types and the one
implementation, `InMemoryProjectionRuntime`. `defineConfig` creates one for you when you do not pass
`projectionRuntime`, registers your `projections`, and feeds it every event, so most apps use it through
`@loomwork/app` and the renderers rather than constructing it. Reach for it directly in tests, or when you
wire a surface of your own.

```ts
import { InMemoryProjectionRuntime } from "@loomwork/projection-runtime";
import type { EventEnvelope } from "@loomwork/core";

const runtime = new InMemoryProjectionRuntime({ coalesceNotifications: true });

runtime.register<{ completed: number }>({
  id: "progress",
  version: "1", // bump when the fold's meaning changes (ADR 0095)
  initialState: { completed: 0 },
  handlers: { STEP_COMPLETED: (state) => ({ completed: state.completed + 1 }) },
});

declare const event: EventEnvelope; // normally from EventStore.subscribe, or defineConfig's feed
runtime.handleEvent(event);

const stop = runtime.subscribeSelector<{ completed: number }, number>(
  "progress",
  event.executionId,
  (state) => state.completed,
  (completed) => console.log("completed steps:", completed)
);
stop();
```

## Surface

- **Types.** `Projection` (`id`, `initialState`, `handlers` or an event-type-gated `lazy` loader, optional
  `version`) and `ProjectionRuntime`.
- **Reads.** `getState(projectionId, executionId)` returns `initialState` for an execution it has seen no
  events for, and throws for a projection that was never registered.
- **Subscriptions.** `subscribe` fires on every change. `subscribeSelector` fires only when a selected
  slice changes (`Object.is` by default, or your `isEqual`), and not on subscribe (ADR 0068).
- **Feeding.** `handleEvent(event)` and `seedState(...)`. `forget(executionId)` drops a finished
  execution's state and subscribers.

## Behaviour that surprises people

- **State lives in memory.** Nothing here persists it, and a new process starts from `initialState`.
- **Retention is bounded.** `maxExecutions` (default 10,000) keeps the most recently touched executions.
  An evicted execution reads as `initialState` again, but an execution with a live subscriber is skipped
  by eviction (the scan gives up after 64 candidates, so the cap can be exceeded).
- **Notifications are synchronous by default.** `coalesceNotifications: true` flushes once per
  microtask with the latest state, so a burst of events reaches subscribers once.
- **A lazy projection loads its fold code on the first matching event.** If that load fails, the
  projection is abandoned and its buffered events are dropped; the buffer is capped at 10,000.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0068](../../docs/adr/0068-projection-selector-subscription.md): selector subscriptions.
- [ADR 0095](../../docs/adr/0095-binding-semantics-pin.md): the declared `version` and pin checks.
- API reference: section "`@loomwork/projection-runtime`" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
