import type { ScheduleDefinition } from "@loom/core";
import type { ZodSchema } from "zod";
import { durableState } from "./durableState";
import type {
  ClearResult,
  DurableStateHandle,
  DurableStateStore,
  EffectRegistry,
  LoadResult,
  Migration,
  SaveResult,
  TaskExecutor,
} from "./types";

export interface SentinelStateConfig<T> {
  /** The schedule whose occurrences share this state — the key derives from its id. */
  schedule: Pick<ScheduleDefinition, "id">;
  schema: ZodSchema<T>;
  /** Current contract version; defaults to 1. */
  version?: number;
  migrations?: Readonly<Record<number, Migration>>;
  store: DurableStateStore;
  /** Contract id override; defaults to `<scheduleId>.state`. */
  id?: string;
}

export interface SentinelStateHandle<T> {
  /** The derived state key: `sentinel:<scheduleId>`. */
  readonly key: string;
  /** The underlying handle, for advanced use (extra keys, explicit step ids). */
  readonly state: DurableStateHandle<T>;
  register(runtime: EffectRegistry): void;
  load(ctx: TaskExecutor): Promise<LoadResult<T>>;
  save(ctx: TaskExecutor, value: T, expectedRevision: number): Promise<SaveResult>;
  clear(ctx: TaskExecutor): Promise<ClearResult>;
}

/**
 * DS-5 — the §2 P-1 sentinel pattern as one declaration: a `schedule$`-driven
 * agent's carry state, keyed by the schedule id. Each occurrence loads at wake
 * (recorded, validated, migrated), does its work, and saves with the loaded
 * revision — T1's one-live-occurrence-per-schedule guarantee makes the CAS a
 * misconfiguration tripwire rather than a contention point.
 */
export function sentinelState<T>(config: SentinelStateConfig<T>): SentinelStateHandle<T> {
  const state = durableState<T>({
    id: config.id ?? `${config.schedule.id}.state`,
    version: config.version ?? 1,
    schema: config.schema,
    ...(config.migrations !== undefined && { migrations: config.migrations }),
    store: config.store,
  });
  const key = `sentinel:${config.schedule.id}`;
  return {
    key,
    state,
    register: (runtime) => state.register(runtime),
    load: (ctx) => state.load(ctx, key),
    save: (ctx, value, expectedRevision) => state.save(ctx, key, value, expectedRevision),
    clear: (ctx) => state.clear(ctx, key),
  };
}
