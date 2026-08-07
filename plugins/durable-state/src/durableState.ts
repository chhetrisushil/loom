import type { TaskDefinition } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import { z } from "zod";
import { canonicalEqual } from "./canonical";
import { RevisionConflictError, StateContractMismatchError } from "./errors";
import type {
  ClearInput,
  ClearResult,
  DurableStateConfig,
  DurableStateHandle,
  DurableStateRecord,
  EffectRegistry,
  LoadInput,
  LoadResult,
  SaveInput,
  SaveResult,
  TaskExecutor,
} from "./types";

/**
 * DS-3 — bring a stored envelope to the current contract: apply the
 * version-to-version migration chain, then validate against the current
 * schema. Every failure mode is a loud, typed {@link StateContractMismatchError}
 * (DS-2: a run never proceeds on unvalidated state).
 */
function migrateRecord<T>(
  config: DurableStateConfig<T>,
  key: string,
  record: DurableStateRecord
): { value: T; migrated: { from: number; to: number } | null } {
  const from = record.contractVersion;
  if (from > config.version) {
    throw new StateContractMismatchError(
      config.id,
      "future-version",
      from,
      config.version,
      `key "${key}" was written by a newer deployment`
    );
  }
  let payload = record.payload;
  for (let v = from; v < config.version; v++) {
    const step = config.migrations?.[v];
    if (step === undefined) {
      throw new StateContractMismatchError(
        config.id,
        "no-migration-path",
        from,
        config.version,
        `key "${key}": no migration registered for v${v} → v${v + 1}`
      );
    }
    try {
      payload = step(payload);
    } catch (err) {
      throw new StateContractMismatchError(
        config.id,
        "migration-failed",
        from,
        config.version,
        `key "${key}": migration v${v} → v${v + 1} threw: ${String(err)}`
      );
    }
  }
  const parsed = config.schema.safeParse(payload);
  if (!parsed.success) {
    throw new StateContractMismatchError(
      config.id,
      "validation-failed",
      from,
      config.version,
      `key "${key}": ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`
    );
  }
  return {
    value: parsed.data,
    migrated: from < config.version ? { from, to: config.version } : null,
  };
}

function isRevisionConflict(err: unknown): err is RevisionConflictError {
  return (
    err instanceof RevisionConflictError ||
    (typeof err === "object" && err !== null && (err as Error).name === "RevisionConflictError")
  );
}

/**
 * ADR 0051 D2 — typed, versioned, migratable keyed state as RECORDED effects.
 * `load`/`save` run through `ctx.execute`, so results land in STEP_COMPLETED:
 * replay folds the recorded value and never touches the backing store —
 * replay-correct by construction (DS-1). This is deliberately NOT `memory$`,
 * which is a non-replayable agent-layer side channel.
 */
export function durableState<T>(config: DurableStateConfig<T>): DurableStateHandle<T> {
  if (config.id.length === 0) {
    throw new TypeError("durableState: config.id must be a non-empty string");
  }
  if (!Number.isInteger(config.version) || config.version < 1) {
    throw new TypeError(`durableState "${config.id}": version must be an integer ≥ 1`);
  }

  const toolIds = {
    load: `${config.id}.load`,
    save: `${config.id}.save`,
    clear: `${config.id}.clear`,
  } as const;

  const loadOutputSchema = z.object({
    found: z.boolean(),
    value: config.schema.nullable(),
    revision: z.number().int().nonnegative(),
    contractVersion: z.number().int().positive(),
    migrated: z
      .object({ from: z.number().int().positive(), to: z.number().int().positive() })
      .nullable(),
  }) as unknown as z.ZodSchema<LoadResult<T>>;

  const tasks: DurableStateHandle<T>["tasks"] = {
    load: {
      _tag: "TaskDefinition",
      kind: "memory",
      id: toolIds.load,
      toolId: toolIds.load,
      name: `${config.id} load`,
      inputSchema: z.object({ key: z.string() }) as z.ZodSchema<LoadInput>,
      outputSchema: loadOutputSchema,
    },
    save: {
      _tag: "TaskDefinition",
      kind: "memory",
      id: toolIds.save,
      toolId: toolIds.save,
      name: `${config.id} save`,
      outputSchema: z.object({ revision: z.number().int().positive() }) as z.ZodSchema<SaveResult>,
    },
    clear: {
      _tag: "TaskDefinition",
      kind: "memory",
      id: toolIds.clear,
      toolId: toolIds.clear,
      name: `${config.id} clear`,
      outputSchema: z.object({ cleared: z.literal(true) }) as z.ZodSchema<ClearResult>,
    },
  };

  const loadEffect = new ToolEffect<LoadInput, LoadResult<T>>(
    async ({ key }) => {
      const record = await config.store.load(key);
      if (record === null) {
        return {
          found: false,
          value: null,
          revision: 0,
          contractVersion: config.version,
          migrated: null,
        };
      }
      const { value, migrated } = migrateRecord(config, key, record);
      return {
        found: true,
        value,
        revision: record.revision,
        contractVersion: config.version,
        migrated,
      };
    },
    // ADR 0073 — deliberately NO `mode`. `load` is genuinely dual-seam: journaled
    // inside a flow (where the recorded value is what replay folds), and a
    // perfectly reasonable ambient read outside one — an operator dashboard
    // peeking at a sentinel's carry state changes nothing and should not have to
    // start an execution to look. Pinning it to either seam would forbid a
    // legitimate caller, which is why the marker is opt-in rather than required.
    { idempotent: true }
  );

  // K9 — declared idempotent: the CAS makes a crash-recovery re-run safe. If the
  // prior attempt committed, the re-run's expectedRevision now trails by exactly
  // one; when the stored envelope is byte-equal to what we tried to write, adopt
  // it as our own committed write. A genuinely concurrent writer either lands at
  // a different revision or a different payload — both still conflict loudly.
  const saveEffect = new ToolEffect<SaveInput<T>, SaveResult>(
    async ({ key, value, expectedRevision }) => {
      const parsed = config.schema.safeParse(value);
      if (!parsed.success) {
        throw new StateContractMismatchError(
          config.id,
          "validation-failed",
          config.version,
          config.version,
          `key "${key}" (save): ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`
        );
      }
      try {
        const record = await config.store.save(
          key,
          { contractVersion: config.version, payload: parsed.data },
          expectedRevision
        );
        return { revision: record.revision };
      } catch (err) {
        if (isRevisionConflict(err) && err.actualRevision === expectedRevision + 1) {
          const current = await config.store.load(key);
          if (
            current !== null &&
            current.revision === expectedRevision + 1 &&
            current.contractVersion === config.version &&
            canonicalEqual(current.payload, parsed.data)
          ) {
            return { revision: current.revision };
          }
        }
        throw err;
      }
    },
    {
      idempotent: true,
      // ADR 0073 — a mutation that MUST be recorded. The whole contract of this
      // plugin is "RECORDED effects: replay folds the recorded value, never the
      // store" (ADR 0053). A transient write would mutate the store while the log
      // learns nothing, so replay would fold a state the run never produced —
      // exactly the split-brain the recorded-effect design exists to prevent.
      mode: "journaled",
    }
  );

  const clearEffect = new ToolEffect<ClearInput, ClearResult>(
    async ({ key }) => {
      await config.store.clear(key);
      return { cleared: true };
    },
    {
      idempotent: true,
      // ADR 0073 — a mutation that MUST be recorded. The whole contract of this
      // plugin is "RECORDED effects: replay folds the recorded value, never the
      // store" (ADR 0053). A transient write would mutate the store while the log
      // learns nothing, so replay would fold a state the run never produced —
      // exactly the split-brain the recorded-effect design exists to prevent.
      mode: "journaled",
    }
  );

  const effects: DurableStateHandle<T>["effects"] = {
    load: loadEffect,
    save: saveEffect,
    clear: clearEffect,
  };

  const taskWith = <TIn, TOut>(
    task: TaskDefinition<TIn, TOut>,
    stepId: string | undefined
  ): TaskDefinition<TIn, TOut> => (stepId === undefined ? task : { ...task, id: stepId });

  return {
    id: config.id,
    version: config.version,
    toolIds,
    tasks,
    effects,
    register(runtime: EffectRegistry): void {
      runtime.register(toolIds.load, loadEffect);
      runtime.register(toolIds.save, saveEffect);
      runtime.register(toolIds.clear, clearEffect);
    },
    load(ctx: TaskExecutor, key: string, opts?: { stepId?: string }): Promise<LoadResult<T>> {
      return ctx.execute(taskWith(tasks.load, opts?.stepId), { key });
    },
    save(
      ctx: TaskExecutor,
      key: string,
      value: T,
      expectedRevision: number,
      opts?: { stepId?: string }
    ): Promise<SaveResult> {
      return ctx.execute(taskWith(tasks.save, opts?.stepId), { key, value, expectedRevision });
    },
    clear(ctx: TaskExecutor, key: string, opts?: { stepId?: string }): Promise<ClearResult> {
      return ctx.execute(taskWith(tasks.clear, opts?.stepId), { key });
    },
  };
}
