import type { ExecutableTask, TaskDefinition } from "@loom/core";
import type { Effect } from "@loom/effect-runtime";
import type { ZodSchema } from "zod";

/** The stored envelope: what a backend persists per key. Revisions start at 1. */
export interface DurableStateRecord {
  contractVersion: number;
  revision: number;
  payload: unknown;
}

/**
 * The durable-state store SPI. Backends are dumb keyed CAS stores — all
 * contract knowledge (schemas, migrations) lives above, in {@link durableState}.
 * `save` with `expectedRevision: 0` creates; any mismatch rejects with
 * {@link RevisionConflictError} (`name: "RevisionConflictError"` for 3P
 * backends that cannot share the class). Conformance:
 * `runDurableStateStoreConformance` in `@loom/conformance`.
 */
export interface DurableStateStore {
  load(key: string): Promise<DurableStateRecord | null>;
  save(
    key: string,
    value: { contractVersion: number; payload: unknown },
    expectedRevision: number
  ): Promise<DurableStateRecord>;
  /** Remove the key. Idempotent. */
  clear(key: string): Promise<void>;
  close?(): Promise<void>;
}

/** DS-3 — one migration step: payload at version N → payload at version N+1. */
export type Migration = (value: unknown) => unknown;

export interface DurableStateConfig<T> {
  /** Contract id — namespaces the registered tool ids (`<id>.load` / `<id>.save` / `<id>.clear`). */
  id: string;
  /** Current contract version (integer ≥ 1). Stored envelopes carry the version they were written under. */
  version: number;
  /** The CURRENT version's schema. Every load validates against it after migration. */
  schema: ZodSchema<T>;
  /** `migrations[n]` migrates a payload from version n to n+1. Sparse maps stall loudly (DS-3). */
  migrations?: Readonly<Record<number, Migration>>;
  store: DurableStateStore;
}

export interface LoadInput {
  key: string;
}

export interface LoadResult<T> {
  found: boolean;
  /** Validated, current-contract value — `null` when not found. */
  value: T | null;
  /** Pass back to `save` as `expectedRevision` (0 when not found → create). */
  revision: number;
  contractVersion: number;
  /** Non-null when a stored older envelope was migrated on this load (recorded in the step output). */
  migrated: { from: number; to: number } | null;
}

export interface SaveInput<T> {
  key: string;
  value: T;
  expectedRevision: number;
}

export interface SaveResult {
  revision: number;
}

export interface ClearInput {
  key: string;
}

export interface ClearResult {
  cleared: true;
}

/** Structural view of `EffectRuntime.register` — anything that accepts (toolId, effect). */
export interface EffectRegistry {
  register(toolId: string, effect: Effect): void;
}

/** Structural view of the execution context — `WorkflowContext.execute` satisfies it. */
export interface TaskExecutor {
  execute<TIn, TOut>(task: ExecutableTask<TIn, TOut>, input: TIn): Promise<TOut>;
}

export interface DurableStateHandle<T> {
  readonly id: string;
  readonly version: number;
  readonly toolIds: { load: string; save: string; clear: string };
  /** `ctx.execute`-able task metadata (kind "memory"); ids default to the tool ids. */
  readonly tasks: {
    load: TaskDefinition<LoadInput, LoadResult<T>>;
    save: TaskDefinition<SaveInput<T>, SaveResult>;
    clear: TaskDefinition<ClearInput, ClearResult>;
  };
  /** The effects to register — or call {@link DurableStateHandle.register}. */
  readonly effects: {
    load: Effect<LoadInput, LoadResult<T>>;
    save: Effect<SaveInput<T>, SaveResult>;
    clear: Effect<ClearInput, ClearResult>;
  };
  register(runtime: EffectRegistry): void;
  /**
   * Recorded read (DS-1): the result folds from STEP_COMPLETED on replay — the
   * store is never re-read. One call per default step id; pass `stepId` for
   * additional loads in the same run.
   */
  load(ctx: TaskExecutor, key: string, opts?: { stepId?: string }): Promise<LoadResult<T>>;
  /** Recorded CAS write (DS-1/DS-4). `expectedRevision` comes from the prior load (0 = create). */
  save(
    ctx: TaskExecutor,
    key: string,
    value: T,
    expectedRevision: number,
    opts?: { stepId?: string }
  ): Promise<SaveResult>;
  clear(ctx: TaskExecutor, key: string, opts?: { stepId?: string }): Promise<ClearResult>;
}
