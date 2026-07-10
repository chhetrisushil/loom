import type { EventEnvelope } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { virtualClock } from "./clock";
import type { VirtualClock } from "./clock";
import {
  type FaultDraw,
  type FaultInjectingStore,
  type FaultModel,
  faultInjectingStore,
} from "./faultStore";
import { type Rng, splitmix64 } from "./rng";

// ── SimWorld — one simulated universe ─────────────────────────────────────────
//
// A SimWorld bundles the seeded sources (rng, virtual clock) and a shared, fault-
// injecting event store, and hands out fresh `WorkflowRuntime` instances over that
// store. Each `spawn()` models a NEW worker process picking up the (shared) durable
// log — so a scenario drives a crash by running on one spawn, then recovers on the
// next, exactly as production re-dispatch works. All entropy flows from the seed, so
// two worlds built from the same seed + fault source behave identically.

/** How a flow set is registered onto each spawned runtime + its effect runtime. */
export type RegisterFlows = (runtime: WorkflowRuntime, effects: EffectRuntime) => void;

export interface SimWorldOptions {
  seed: bigint;
  /** Explore mode: sample faults from the seed. Ignored when `replay` is set. */
  faults?: FaultModel;
  /** Replay mode: apply exactly these recorded draws (deterministic, no sampling). */
  replay?: readonly FaultDraw[];
  /** Registers the flows/tools under test onto every spawned runtime. */
  registerFlows: RegisterFlows;
}

export interface SimWorld {
  readonly seed: bigint;
  readonly rng: Rng;
  readonly clock: VirtualClock;
  /** The fault-injecting store handed to spawned runtimes. */
  readonly eventStore: EventStore;
  /** The underlying real store — read it for assertions on what actually persisted. */
  readonly innerStore: InMemoryAsyncEventStore;
  readonly snapshotStore: InMemoryAsyncSnapshotStore;
  /** The fault controller (crashed flag, recorded draws, restore()). */
  readonly faults: FaultInjectingStore;
  /** A fresh runtime over the shared stores — a new "worker process". */
  spawn(): WorkflowRuntime;
  /** The durable events for an execution (post-fault), in sequence order. */
  logOf(executionId: string): Promise<readonly EventEnvelope[]>;
  /** The recorded fault schedule so far — a replayable witness. */
  schedule(): FaultDraw[];
}

/** Build a {@link SimWorld}. */
export function simWorld(opts: SimWorldOptions): SimWorld {
  const rng = splitmix64(opts.seed);
  const clock = virtualClock();
  const innerStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  // The fault store draws from a FORK of the seed so a scenario's own rng use never
  // shifts fault sampling (independent streams under one seed).
  const faults = faultInjectingStore(
    innerStore,
    opts.replay !== undefined
      ? { mode: "replay", draws: opts.replay }
      : { mode: "explore", rng: rng.fork("faults"), model: opts.faults ?? {} }
  );

  const world: SimWorld = {
    seed: opts.seed,
    rng,
    clock,
    eventStore: faults.store,
    innerStore,
    snapshotStore,
    faults,
    spawn(): WorkflowRuntime {
      const effects = new EffectRuntime();
      const runtime = new WorkflowRuntime({
        eventStore: faults.store as never,
        snapshotStore,
        effectRuntime: effects,
      });
      opts.registerFlows(runtime, effects);
      return runtime;
    },
    logOf: (executionId) => innerStore.read(executionId),
    schedule: () => [...faults.draws],
  };
  return world;
}
