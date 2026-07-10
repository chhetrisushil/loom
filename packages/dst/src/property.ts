import type { FaultDraw, FaultModel } from "./faultStore";
import { ALL_INVARIANTS, type Invariant } from "./invariants";
import { type RegisterFlows, type SimWorld, simWorld } from "./simWorld";

// ── Property runner — search, witness, shrink ─────────────────────────────────
//
// `checkProperty` runs a scenario under many seeded fault schedules and checks the
// invariants after each. The first violation is captured as a witness (seed + the
// exact `FaultDraw[]` that reproduces it) and then SHRUNK by delta-debugging: drop
// subsets of the recorded faults and replay; if the violation survives with fewer
// faults, keep the smaller set. The result is the minimal fault schedule that still
// breaks an invariant — the artifact you pin as a regression.

/** The execution + scenario under test. */
export interface DstProperty {
  name: string;
  /** Fault probabilities to explore (per seed). */
  faults?: FaultModel;
  /** Which invariants to enforce (default: all built-ins). */
  invariants?: readonly Invariant[];
  /** Registers the flows/tools onto each spawned runtime. */
  registerFlows: RegisterFlows;
  /**
   * Drives the execution: start a flow, let a crash land, restore, recover, etc.
   * The target execution id whose log the invariants check is returned. Any throw
   * is treated as a scenario error (not an invariant violation) and surfaced.
   */
  scenario: (world: SimWorld) => Promise<string>;
}

export interface DstViolation {
  invariant: string;
  evidence?: unknown;
}

export interface DstReport {
  ok: boolean;
  property: string;
  /** Seeds executed before the report was produced. */
  seedsRun: number;
  /** The failing seed (if any). */
  seed?: bigint;
  violation?: DstViolation;
  /** The minimal replayable fault schedule that reproduces the violation. */
  minimizedSchedule?: FaultDraw[];
  /** The full recorded schedule for the failing seed (pre-shrink), for reference. */
  schedule?: FaultDraw[];
}

async function runOnce(
  prop: DstProperty,
  world: SimWorld
): Promise<{ executionId: string; violation?: DstViolation }> {
  const executionId = await prop.scenario(world);
  const log = await world.logOf(executionId);
  const invariants = prop.invariants ?? ALL_INVARIANTS;
  for (const inv of invariants) {
    const res = inv.check({ log });
    if (!res.ok) return { executionId, violation: { invariant: inv.name, evidence: res.evidence } };
  }
  return { executionId };
}

/**
 * Replay a property against an EXACT recorded fault schedule (no sampling). Returns
 * whether the same violation reproduces — the deterministic core the shrinker and
 * pinned regression tests rely on.
 */
export async function replaySchedule(
  prop: DstProperty,
  schedule: readonly FaultDraw[],
  seed = 0n
): Promise<{ ok: boolean; violation?: DstViolation }> {
  const world = simWorld({ seed, replay: schedule, registerFlows: prop.registerFlows });
  const { violation } = await runOnce(prop, world);
  return violation === undefined ? { ok: true } : { ok: false, violation };
}

/** Delta-debug a failing schedule to a locally-minimal reproducing subset. */
async function shrink(
  prop: DstProperty,
  schedule: FaultDraw[],
  target: string,
  seed: bigint
): Promise<FaultDraw[]> {
  let current = schedule;
  let granularity = 2;
  // ddmin: try ever-finer partitions; drop any chunk whose removal keeps the failure.
  // The seed is held FIXED so the scenario's own (seeded) choices are unchanged and
  // only the fault set varies — the reduction is sound.
  while (current.length >= 2) {
    const chunkSize = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let i = 0; i < current.length; i += chunkSize) {
      const candidate = [...current.slice(0, i), ...current.slice(i + chunkSize)];
      if (candidate.length === current.length) continue;
      const { violation } = await replaySchedule(prop, candidate, seed);
      if (violation?.invariant === target) {
        current = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(granularity * 2, current.length);
    }
  }
  return current;
}

/**
 * Search for a fault schedule that violates one of the property's invariants. Runs
 * `seeds` seeded schedules (default 50) starting from `startSeed`. On the first
 * violation, shrinks the reproducing schedule and returns it. `ok: true` means no
 * violation was found in the searched seeds (absence of a counterexample, not proof).
 */
export async function checkProperty(
  prop: DstProperty,
  opts: { seeds?: number; startSeed?: bigint } = {}
): Promise<DstReport> {
  const seeds = opts.seeds ?? 50;
  const start = opts.startSeed ?? 1n;
  for (let i = 0; i < seeds; i++) {
    const seed = start + BigInt(i);
    const world = simWorld({
      seed,
      registerFlows: prop.registerFlows,
      ...(prop.faults !== undefined && { faults: prop.faults }),
    });
    const { violation } = await runOnce(prop, world);
    if (violation) {
      const schedule = world.schedule();
      const minimized = await shrink(prop, schedule, violation.invariant, seed);
      return {
        ok: false,
        property: prop.name,
        seedsRun: i + 1,
        seed,
        violation,
        minimizedSchedule: minimized,
        schedule,
      };
    }
  }
  return { ok: true, property: prop.name, seedsRun: seeds };
}
