# @loomwork/replay-vm — the fold from events to state

Loom keeps an execution as an append-only list of events and derives its state by folding them. This
package is that fold, and nothing else: `foldEvents(events, initial?)` is a synchronous, in-memory reduce
that applies one handler per known event type and returns an `ExecutionState`. It does no I/O, runs no flow
code and calls no effects. "Replay" happens elsewhere: `@loomwork/workflow-runtime` re-runs your flow function
against the folded state and, through `ReplayVM`, answers `hasCompleted(stepId)` and `getOutput(stepId)`
from the record so a completed step is served rather than executed again. You import this directly to
reconstruct state from a log you already hold (tools, analytics, tests) or to read the event-schema version.
The runtime rebuilds state through this fold on resume, so a change to it changes how an existing log is read.

```ts
import { EVENT_SCHEMA_VERSION, ReplayVM, foldEvents, knownEventTypes } from "@loomwork/replay-vm";
import { app, helloFlow } from "./config"; // your defineConfig result and a registered flow

const handle = await app.runtime.start(helloFlow, { name: "Ada" });
await handle.waitForCompletion();

// The log is the source of truth; the state is a fold of it.
const events = await app.stores.eventStore.read(handle.executionId);
const state = foldEvents(events); // pure and synchronous: no I/O, no flow code, no effects
console.log(state.status, state.sequence, state.variables._output); // "completed" 3 { message: "Hello, Ada!" }

// Or fold incrementally, and ask about individual steps.
const vm = new ReplayVM(events.slice(0, -1));
vm.applyEvent(events[events.length - 1]!);
console.log(vm.hasCompleted("greet"), vm.getOutput("greet"), vm.getState().status);

console.log(EVENT_SCHEMA_VERSION, knownEventTypes().length);
```

## Surface

- **`foldEvents(events, initial?)`.** Starts from a default `pending` state, or from `initial` such as a
  snapshot's state, applies events in order, and sets `sequence` to the last event's.
  `normalizeSnapshotState(state)` reads an older snapshot as the current fold would have written it.
- **`ReplayVM`.** `new ReplayVM(events, initial?)`, `applyEvent`, `getState()`, `peekState()`,
  `hasCompleted`, `hasFailed`, `getOutput`, `getTypedFailure`, `hasDecision`, `getDecision`,
  `flowEmitCount`, `recordedFrames`, `expectedReplayFrames`.
- **Event-schema ABI.** `EVENT_SCHEMA_VERSION` (currently 1.26.0) and `knownEventTypes()`, the sorted set
  the fold handles. A governance test pins the set; the event schema is versioned and additive.
- **Fold limits and constants.** `INBOX_DEDUPE_CAP`, `QUARANTINE_FOLD_CAP`, the custom-dimension limits,
  `KERNEL_STAMPED_EVENT_TYPES`, `FAILED_WHILE_PARKED`, `FLOW_DIVERGED_GATE`.

## Behaviour that surprises people

- **An unknown event type is a no-op, but `sequence` still advances.** Application events with no handler
  fold as nothing, which is also why an old log keeps folding under a newer schema.
- **Some kinds fold only when the kernel wrote them.** `EXECUTION_CONTINUED`, `MESSAGE_CONSUMED`,
  `PARALLEL_COMPLETED`, `INBOX_QUARANTINED` and `INBOX_RELEASED` take effect only with
  `metadata.kernel === true`, so an application event that borrows one of those names cannot change state.
- **A snapshot is a stored fold, and folds can change.** From schema 1.26.0 settled frames no longer carry
  `input`, and from 1.21.0 a failed step no longer marks the whole execution failed. Run an older
  snapshot's state through `normalizeSnapshotState` before treating `fold(snapshot, tail)` as equal to
  `fold(events)`.
- **`getState()` and `peekState()` differ.** `getState()` returns a state that later `applyEvent` calls will
  never write to, at the cost of one container copy on the next commit. `peekState()` is a borrowed live
  view: read it and drop it before the next `applyEvent`.
- **`foldEvents` shares structure.** The result reuses unchanged parts of `initial`, so treat both as
  immutable (ADR 0015).

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/replay-vm` — deterministic replay" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [event schema reference](../../docs/loom-2.0/10-event-schema-reference.md), [architecture, core runtime](../../docs/architecture.md), [determinism rules](../../docs/user-guide.md#14-determinism-rules--pitfalls).
- ADRs: [0015 DSA performance optimizations](../../docs/adr/0015-dsa-performance-optimizations.md) (structural sharing), [0105 a caught step failure is not the execution's](../../docs/adr/0105-a-caught-step-failure-is-not-the-executions.md), [0138 compaction archives](../../docs/adr/0138-compaction-archives-what-it-removes.md).
- Source: `packages/replay-vm/src`. Reading a log at a point in time: [`@loomwork/replay-inspector`](../replay-inspector/README.md).
