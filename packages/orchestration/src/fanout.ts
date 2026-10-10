import type { StepDefinition } from "@loom/core";
import { declareReach } from "@loom/verify";
import type { ExecutionContext } from "@loom/workflow-runtime";

// ── ADR 0061 D4 — runtime-sized deterministic fan-out (the DE-1 residue) ──────
//
// Pure userspace over `ctx.parallel`: each item gets a step minted from the
// base with the identity-rule id `${base.id}#${index}`, so a runtime-sized
// fan-out is replay-deterministic by construction — frames are keyed by those
// ids, crash-mid-fan-out recovery re-executes only the frames that never
// completed, and results come back in input order (parallelLimit's contract).
// No kernel surface; the dormant PARALLEL_* bracket events stay dormant.

export interface FanoutOptions {
  /** Max concurrent effects (forwarded to `ctx.parallel`). Unset = unbounded. */
  limit?: number;
}

/**
 * Run `baseStep` once per item, concurrently, with deterministic per-item step
 * identity (`${baseStep.id}#${i}`). Results are positionally aligned with
 * `items`. Nested fanouts compose — ids concatenate (`hydrate#2#0`).
 *
 * The items array must itself derive from logged inputs (the ADR 0061 identity
 * rule); typed failures on declared channels reject the join with the
 * TypedFailure and substitute on replay exactly as in serial code (ADR 0060).
 */
export async function fanout$<TIn, TOut>(
  ctx: Pick<ExecutionContext, "parallel">,
  baseStep: StepDefinition<TIn, TOut>,
  items: readonly TIn[],
  options: FanoutOptions = {}
): Promise<TOut[]> {
  const pairs = items.map(
    (item, i) =>
      [{ ...baseStep, id: `${baseStep.id}#${i}` }, item] as [StepDefinition<unknown, TOut>, unknown]
  );
  return ctx.parallel(
    pairs as Parameters<ExecutionContext["parallel"]>[0],
    options.limit !== undefined ? { limit: options.limit } : undefined
  ) as Promise<TOut[]>;
}

// L34 - declared reach (ADR 0086). `fanout$` runs ITS CALLER's step (argument 1) through `ctx.parallel`,
// so a fixed tool list would be wrong for every caller: `stepArgs: [1]` tells the verifier to read the
// step at each hand-off site instead. It reaches nothing else.
declareReach(fanout$, { run: [], transient: [], stepArgs: [1] });
