import { schedule$ } from "@loom/core";
import type { ScheduleDefinition } from "@loom/core";
import type { EffectMiddleware } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import { claimCheckMiddleware } from "@loom/middleware";
import type { ClaimCheckOptions, ClaimCheckStore } from "@loom/middleware";
import { pinByEventKinds } from "@loom/plugin-content";
import { sentinelState } from "@loom/plugin-durable-state";
import type {
  DurableStateStore,
  EffectRegistry,
  Migration,
  SentinelStateHandle,
} from "@loom/plugin-durable-state";
import type { ZodSchema } from "zod";

// ── DX-1 (db-copilot infra, issue #187) — the perpetual-agent pattern as one
// declaration. Composition-time only (ADR 0043/0044): the preset ASSEMBLES the
// shipped pieces (schedule$ over bounded runs, contract-migratable carry state,
// claim-checked telemetry, the K10.6 pin policy) — it adds no runtime behavior
// of its own, so everything it returns is testable/replaceable independently.
// The de-composed version of everything here is db-sentinel (in the sibling
// loom-examples repo).

export interface SentinelPresetConfig<TState> {
  /** Schedule id — the agent's stable identity (`chain_id = scheduleId`). */
  id: string;
  /** 5-field cron, UTC. */
  cron: string;
  /** Flow the schedule starts; defaults to `<id>-flow`. */
  flowId?: string;
  /** Carry-state contract (DS-2/3): current schema + version-to-version migrations. */
  state: {
    schema: ZodSchema<TState>;
    version?: number;
    migrations?: Readonly<Record<number, Migration>>;
  };
  stateStore: DurableStateStore;
  contentStore: ClaimCheckStore;
  /** Claim-check inline cap; default 16 KiB (ADR 0054). */
  inlineCapBytes?: number;
  /** Per-tool declared digests (CC-2). */
  digests?: ClaimCheckOptions["digests"];
  onOffload?: ClaimCheckOptions["onOffload"];
  /**
   * Domain event kinds whose citations pin content/executions (K10.6 policy —
   * feed to `sweepUnpinnedContent`/`retention.pinned`). Default
   * `["FINDING_RECORDED"]`.
   */
  pinnedEventTypes?: readonly string[];
}

export interface SentinelPreset<TState> {
  /** Wire into `defineConfig({ timers: { schedules: [preset.schedule] } })`. */
  schedule: ScheduleDefinition;
  /** Carry state: `load(ctx)` at wake, `save(ctx, next, loaded.revision)` at rest. */
  state: SentinelStateHandle<TState>;
  /** Wire into `defineConfig({ execution: { effectMiddleware: preset.middleware } })`. */
  middleware: EffectMiddleware[];
  /** The K10.6 pin policy — feed to the sweep and `retention.pinned`. */
  pinnedEventTypes: readonly string[];
  /** Registers the carry-state effects; register your own tools alongside. */
  register(effects: EffectRegistry): void;
  /** `retention.pinned` predicate over the given store (pins runs carrying findings). */
  pinPredicate(eventStore: Pick<EventStore, "read">): (executionId: string) => Promise<boolean>;
  /** T1's deterministic occurrence identity: `<scheduleId>@<epochMs>`. */
  occurrenceId(t: number): string;
  occurrenceOf(executionId: string): number;
}

export function sentinelPreset<TState>(
  config: SentinelPresetConfig<TState>
): SentinelPreset<TState> {
  const flowId = config.flowId ?? `${config.id}-flow`;
  const schedule = schedule$({ id: config.id, cron: config.cron, flowId, input: {} });

  const state = sentinelState<TState>({
    schedule,
    schema: config.state.schema,
    version: config.state.version ?? 1,
    ...(config.state.migrations !== undefined && { migrations: config.state.migrations }),
    store: config.stateStore,
  });

  const middleware: EffectMiddleware[] = [
    claimCheckMiddleware({
      store: config.contentStore,
      ...(config.inlineCapBytes !== undefined && { inlineCapBytes: config.inlineCapBytes }),
      ...(config.digests !== undefined && { digests: config.digests }),
      ...(config.onOffload !== undefined && { onOffload: config.onOffload }),
    }),
  ];

  const pinnedEventTypes = config.pinnedEventTypes ?? ["FINDING_RECORDED"];

  return {
    schedule,
    state,
    middleware,
    pinnedEventTypes,
    register: (effects) => state.register(effects),
    pinPredicate: (eventStore) => pinByEventKinds(eventStore, pinnedEventTypes),
    occurrenceId: (t) => `${config.id}@${t}`,
    occurrenceOf: (executionId) => Number(executionId.slice(executionId.indexOf("@") + 1)),
  };
}
