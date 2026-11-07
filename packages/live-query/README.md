# @loom/live-query — live reads of in-flight executions

`loadState` folds an execution's state on demand; a **live query** is that plus a subscription:
re-fold and push the new state each time an event lands. No syscall, no new event type — a read-model
over `loadState` + `EventStore.subscribe` (P10). See [ADR 0040](../../docs/adr/0040-live-query-and-orchestration.md).

```ts
import { liveQuery } from "@loom/live-query";

const lq = liveQuery({ eventStore, reader: runtime });

await lq.snapshot(executionId); // current folded state, or null

const unsubscribe = await lq.subscribe(executionId, (state) => {
  render(state);              // called now with the current state, then on every new event
  if (state.status === "completed") unsubscribe();
});
```

Updates are **coalesced**: only one re-fold runs at a time, and a burst of events triggers exactly
one more (latest-wins), so a subscriber never sees stale-then-newer out of order.

A wake-up lost across nodes, for example to a full Postgres NOTIFY queue, is not sent later. So each subscription
also re-reads the log every `pollMs` (default 5 s) until its state is terminal, and a lost wake-up costs that much
delay. A live subscription costs at most two indexed reads per interval. `pollMs: 0` turns this off, and then a lost
wake-up is only recovered by that execution's next event.
