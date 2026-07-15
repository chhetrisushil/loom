import { schedule$, step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import type { EffectMiddleware } from "@loom/effect-runtime";
import { claimCheckMiddleware, isClaimCheck } from "@loom/middleware";
import type { ClaimCheckStore } from "@loom/middleware";
import { sentinelState } from "@loom/plugin-durable-state";
import type { DurableStateStore, EffectRegistry, Migration } from "@loom/plugin-durable-state";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import {
  FINDING_RECORDED,
  type Finding,
  type SentinelInput,
  type SentinelOutput,
  migrations,
  sentinelInputSchema,
  sentinelOutputSchema,
  sentinelStateV1,
  sentinelStateV2,
  sentinelStateV3,
} from "./domain";
import { type OutageWindow, readPgStats, telemetryDigest } from "./substrate";

// ── The sentinel, modeled per ADR 0051 D1 (P-1): a SCHEDULE over bounded runs ─
//
// Every occurrence is a new execution on current code. There is no perpetual
// run, no rotation, no suspension to hand off: the chain identity IS the
// schedule, carry state is recorded durable state, and every wake re-versions
// onto the current deploy for free.

export const FLOW_ID = "pg-sentinel-flow";
export const SCHEDULE_ID = "pg-sentinel";
export const READ_TOOL = "pg.stat.read";
/** Small cap so realistic-but-modest telemetry payloads exercise offload (CC-1). */
export const INLINE_CAP_BYTES = 4096;

export const SENTINEL_SCHEDULE = schedule$<SentinelInput>({
  id: SCHEDULE_ID,
  cron: "0 */6 * * *", // every 6 hours, UTC
  flowId: FLOW_ID,
  input: {} as SentinelInput, // validateInput applies the declared defaults
});

/** T1's deterministic occurrence identity: `scheduleId@occurrenceEpochMs`. */
export function occurrenceId(t: number): string {
  return `${SCHEDULE_ID}@${t}`;
}
export function occurrenceOf(executionId: string): number {
  return Number(executionId.slice(executionId.indexOf("@") + 1));
}

const readStep = step$({
  id: "read-telemetry",
  name: "Read pg_stat aggregates",
  toolId: READ_TOOL,
  inputSchema: z.object({ at: z.number() }),
  outputSchema: z.unknown() as z.ZodSchema<unknown>,
});

const schemaFor = [undefined, sentinelStateV1, sentinelStateV2, sentinelStateV3] as const;

export interface SentinelDeployment {
  flow: RegisteredFlow<SentinelInput, SentinelOutput>;
  schedule: typeof SENTINEL_SCHEDULE;
  middleware: EffectMiddleware[];
  register(effects: EffectRegistry): void;
}

export interface SentinelDeps {
  stateStore: DurableStateStore;
  contentStore: ClaimCheckStore;
  outages?: readonly OutageWindow[];
  /** Override the registered migrations (the negative test deploys v3 WITHOUT a path). */
  migrationsOverride?: Readonly<Record<number, Migration>>;
  onOffload?: Parameters<typeof claimCheckMiddleware>[0]["onOffload"];
}

/**
 * One "deploy" of the sentinel at a given contract version: the flow, its
 * schedule, the claim-check middleware (with the read tool's declared digest —
 * CC-2), and the effect registrations (read tool + durable-state handle).
 */
export function makeSentinel(version: 1 | 2 | 3, deps: SentinelDeps): SentinelDeployment {
  const schema = schemaFor[version]!;
  const registeredMigrations =
    deps.migrationsOverride ??
    (Object.fromEntries(
      Object.entries(migrations).filter(([from]) => Number(from) < version)
    ) as Readonly<Record<number, Migration>>);

  const state = sentinelState({
    schedule: SENTINEL_SCHEDULE,
    schema: schema as z.ZodSchema<Record<string, unknown>>,
    version,
    migrations: registeredMigrations,
    store: deps.stateStore,
  });

  const readEffect = new ToolEffect<{ at: number }, unknown>(
    async ({ at }) => readPgStats(at, deps.outages ?? []),
    { idempotent: true }
  );

  const middleware = [
    claimCheckMiddleware({
      store: deps.contentStore,
      inlineCapBytes: INLINE_CAP_BYTES,
      digests: { [READ_TOOL]: (r) => telemetryDigest(r as never) },
      ...(deps.onOffload !== undefined && { onOffload: deps.onOffload }),
    }),
  ];

  const runner: FlowRunner<SentinelInput, SentinelOutput> = async (ctx, input) => {
    const t = occurrenceOf(ctx.executionId);

    // 1. Carry state in (DS-1..3): validated, migrated if an older deploy wrote it.
    const carried = await state.load(ctx);

    // 2. Observe (CC-1/CC-2): the recorded value is the envelope; orchestration
    //    branches ONLY on the declared digest — never through the ref (CC-5).
    const read = await ctx.run(readStep, { at: t });
    const digest = isClaimCheck(read)
      ? (read.digest as ReturnType<typeof telemetryDigest>)
      : telemetryDigest(read as never); // stale reads are small → recorded inline

    // 3. Conclude (P-2): findings are domain events, inline, citing evidence by ref.
    const anomaly = !digest.stale && digest.maxLagMs > input.thresholdLagMs;
    if (anomaly) {
      const finding: Finding = {
        category: "replication-lag",
        severity: digest.maxLagMs > 800 ? "high" : "low",
        confidence: 0.9,
        target: { database: "orders", metric: "replication_lag_ms" },
        evidence: isClaimCheck(read) ? [{ __loomContent: read.ref.__loomContent }] : [],
        observed: { maxLagMs: digest.maxLagMs, asOf: digest.asOf },
        actingVersion: version,
      };
      ctx.emit(FINDING_RECORDED, finding);
    }

    // 4. Carry state out (DS-4): CAS with the revision the load returned.
    const prior = carried.value as Record<string, unknown> | null;
    const next: Record<string, unknown> = {
      baselineLagMs: digest.stale
        ? ((prior?.baselineLagMs as number) ?? 40)
        : 0.9 * ((prior?.baselineLagMs as number) ?? digest.maxLagMs) + 0.1 * digest.maxLagMs,
      wakes: ((prior?.wakes as number) ?? 0) + 1,
      findings: ((prior?.findings as number) ?? 0) + (anomaly ? 1 : 0),
    };
    if (version >= 2) {
      next.anomalyStreak = anomaly ? ((prior?.anomalyStreak as number) ?? 0) + 1 : 0;
    }
    if (version >= 3) {
      next.lastFindingAt = anomaly ? t : ((prior?.lastFindingAt as number | null) ?? null);
    }
    await state.save(ctx, next, carried.revision);

    return { wake: t, finding: anomaly, stale: digest.stale };
  };

  const definition: FlowDefinition<SentinelInput, SentinelOutput> = {
    _tag: "FlowDefinition",
    id: FLOW_ID,
    name: "Replication-lag sentinel",
    version: `${version}.0.0`,
    inputSchema: sentinelInputSchema as z.ZodSchema<SentinelInput>,
    outputSchema: sentinelOutputSchema as z.ZodSchema<SentinelOutput>,
    steps: [readStep],
  };

  return {
    flow: { definition, runner },
    schedule: SENTINEL_SCHEDULE,
    middleware,
    register(effects: EffectRegistry): void {
      effects.register(READ_TOOL, readEffect as never);
      state.register(effects);
    },
  };
}
