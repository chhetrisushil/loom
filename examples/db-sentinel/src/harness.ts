import type { ExecutionState } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import { InMemoryDurableStateStore } from "@loom/plugin-durable-state";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { SentinelDeployment, SentinelDeps } from "./sentinel";
import { makeSentinel, occurrenceId } from "./sentinel";

// ── Simulation harness: shared durable stores + per-"deploy" runtimes ─────────
//
// The stores are the durable substrate a real deployment shares across process
// generations; each deploy() is a fresh WorkflowRuntime (new code, same logs) —
// exactly what T1 gives a schedule-driven agent on every wake.

export interface SentinelWorld {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
  stateStore: InMemoryDurableStateStore;
  contentStore: InMemoryContentStore;
}

export function newWorld(): SentinelWorld {
  return {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    stateStore: new InMemoryDurableStateStore(),
    contentStore: new InMemoryContentStore(),
  };
}

export interface SentinelDeploy {
  runtime: WorkflowRuntime;
  sentinel: SentinelDeployment;
}

export function deploySentinel(
  world: SentinelWorld,
  version: 1 | 2 | 3,
  deps: Omit<SentinelDeps, "stateStore" | "contentStore"> = {},
  /** Injectable clock (DST): event timestamps carry SIMULATED time, so retention windows mean what they say. */
  now?: () => number
): SentinelDeploy {
  const sentinel = makeSentinel(version, {
    stateStore: world.stateStore,
    contentStore: world.contentStore,
    ...deps,
  });
  const effects = new EffectRuntime(sentinel.middleware);
  sentinel.register(effects);
  const runtime = new WorkflowRuntime({
    eventStore: world.eventStore,
    snapshotStore: world.snapshotStore,
    effectRuntime: effects,
    validateInput: true, // ADR 0051 D7 — schedules and starts parse the contract
    ...(now !== undefined && { now }),
  });
  runtime.registerFlow(sentinel.flow.definition, sentinel.flow.runner);
  return { runtime, sentinel };
}

/**
 * Fire one schedule occurrence with the T1 idempotent-start discipline: a
 * deterministic `scheduleId@occurrence` id, checked against the store before
 * starting — a duplicate fire (crash recovery, cross-node race) is a no-op.
 * Returns the terminal state, or the existing state when skipped.
 */
export async function fireOccurrence(
  deploy: SentinelDeploy,
  t: number
): Promise<{ outcome: "started" | "skipped"; state: ExecutionState }> {
  const executionId = occurrenceId(t);
  const existing = await deploy.runtime.loadState(executionId);
  if (existing !== null) return { outcome: "skipped", state: existing };
  const handle = await deploy.runtime.start(deploy.sentinel.flow, {} as never, { executionId });
  const state = await handle.waitForCompletion().catch(async () => {
    // A loud failure (e.g. StateContractMismatch) is a recorded outcome, not a hang.
    return (await deploy.runtime.loadState(executionId)) as ExecutionState;
  });
  return { outcome: "started", state };
}
