# @loom/telemetry — flow and step callbacks

Turns the kernel's event stream into nine optional callbacks, so you can ship traces and metrics without
reading event envelopes: flow start, complete, fail, suspend and resume, and step start, complete, fail and
retry. You write a `TelemetryAdapter` (a plain object with any subset of the callbacks), and
`createTelemetryHook` turns it into an `(event) => void` that tracks start times and attempt counts for
you. There is no OpenTelemetry dependency; an adapter is where you bring your own. In an app you rarely
call the hook yourself: list adapters under `observability.telemetry` and `defineConfig` composes them,
wires them to the event stream and masks sensitive fields first.

```ts
import { defineConfig } from "@loom/app";
import { ConsoleTelemetryAdapter, type TelemetryAdapter } from "@loom/telemetry";
import { helloFlow } from "./config"; // any registered flow

// Implement any subset of the nine callbacks.
const slowSteps: TelemetryAdapter = {
  onStepComplete: ({ stepId, durationMs }) => {
    if ((durationMs ?? 0) > 1_000) console.warn(`slow step ${stepId}: ${durationMs}ms`);
  },
  onStepRetry: ({ stepId, attempt }) => console.warn(`retrying ${stepId} (attempt ${attempt})`),
};

const app = defineConfig({
  storage: { kind: "memory" },
  flows: [helloFlow],
  // Adapters are composed and fed from the event stream. Fields marked sensitive()/internal() on a
  // step's schema are masked before any adapter sees them.
  observability: { telemetry: [ConsoleTelemetryAdapter, slowSteps] },
});
```

## Surface

- **Adapter contract.** `TelemetryAdapter`, with `FlowTelemetryInfo` (`executionId`, `workflowId`,
  `startedAt`, `durationMs`, `status`, `stepCount`, `suspendCount`) and `StepTelemetryInfo` (`stepId`,
  `attempt`, `durationMs`, `status`, and `input`, `output` or `error` when present).
- **Wiring.** `createTelemetryHook(adapter)` returns the event handler; `composeAdapters(...adapters)`
  fans one event out to several adapters; `ConsoleTelemetryAdapter` prints `[loom] ...` lines.
- **Egress scrubbing.** `scrubPathsByStep(steps)` precomputes each step's `sensitive()` and `internal()`
  paths, `scrubbingAdapter(inner, paths)` wraps an adapter to mask them, and `EGRESS_REDACTED` is the mask.

## Behaviour that surprises people

- **`defineConfig` scrubs for you; the bare hook does not.** If you call `createTelemetryHook` yourself,
  step `input` and `output` reach your adapter unmasked unless you wrap it with `scrubbingAdapter`.
  `secret()` fields are not scrubbed here at all; they are not expected to reach the log in the first
  place.
- **It is a live tail, not the log.** Telemetry runs on the same stream as `onEvent`, which can fire
  before an event's durable write, so after a crash it can report something the log never recorded. For
  a stream that only reports what the log holds, use `observability.onDurableEvent` (ADR 0147).
- **Flow state starts at `EXECUTION_STARTED`.** A hook attached to an execution already in progress
  emits step callbacks but no flow callbacks for it, because it never saw the start.
- **A cancelled or continued execution gets no callback.** There is no `onFlowCancel`; its tracking
  state is just freed. `EXECUTION_CONTINUED` only counts when the envelope carries the kernel stamp.
- **A suspended flow reports a `durationMs`** measured from the start to the suspend, and a resume
  clears it.
- **The hook is bounded by in-flight work.** Entries are dropped when a step finishes or its execution
  reaches a terminal state.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loom/telemetry`" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [operations](../../docs/operations.md), [data classification](../../docs/data-classification.md) (what gets scrubbed).
- ADR: [0147 `onDurableEvent`](../../docs/adr/0147-on-durable-event.md).
- Source: `packages/telemetry/src`.
