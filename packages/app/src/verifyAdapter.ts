import { collectUnreachableMarks } from "@loom/classify";
import { flowContentHash } from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { PlacementDispatcher } from "@loom/dispatcher";
import type { CapabilityAuthorizer } from "@loom/effect-runtime";
import { GrantTable } from "@loom/effect-runtime";
import { EVENT_SCHEMA_VERSION } from "@loom/replay-vm";
import type {
  FlowSpec,
  GrantSpec,
  LoopIdentityCall,
  NonDeterministicCall,
  PlacementSpec,
  RuleName,
  UnreachableMarkRef,
  VerifyInput,
  VerifyMode,
} from "@loom/verify";
import type { WorkflowRuntime } from "@loom/workflow-runtime";

/**
 * The `defineConfig({ verify })` key. A bare mode is the common case; the object form
 * lets an app declare which resource dimensions its metering covers (for the
 * resource-compat rule) or restrict the rule set.
 */
/**
 * Compiler lint findings fed into the determinism rule (the object-form `lint` key).
 * Produce from `@loom/compiler`: `analyzeNonDeterminism` / `analyzeLoopIdentity` over
 * flow-runner source, or read the compiler manifest's per-flow `loopIdentity` field.
 */
export interface VerifyLintInputs {
  readonly nonDeterministicByFlow?: Readonly<Record<string, readonly NonDeterministicCall[]>>;
  readonly loopIdentityByFlow?: Readonly<Record<string, readonly LoopIdentityCall[]>>;
}

export type VerifyConfig =
  | VerifyMode
  | {
      readonly mode?: VerifyMode;
      /** Dimensions the wired metering covers (e.g. `["tokens","costUsd","ms"]`). */
      readonly meteredDimensions?: readonly string[];
      /** Restrict to a subset of rules; defaults to all. */
      readonly rules?: readonly RuleName[];
      /** Compiler lint findings (nondeterminism issue #82, loop identity ADR 0061). */
      readonly lint?: VerifyLintInputs;
    };

export interface NormalizedVerify {
  readonly mode: VerifyMode;
  readonly meteredDimensions?: readonly string[];
  readonly rules?: readonly RuleName[];
  readonly lint?: VerifyLintInputs;
}

/** Normalize the `verify` key. Object form without an explicit mode defaults to `"warn"`. */
export function normalizeVerify(v: VerifyConfig | undefined): NormalizedVerify | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return { mode: v };
  return {
    mode: v.mode ?? "warn",
    ...(v.meteredDimensions !== undefined && { meteredDimensions: v.meteredDimensions }),
    ...(v.rules !== undefined && { rules: v.rules }),
    ...(v.lint !== undefined && { lint: v.lint }),
  };
}

export interface VerifyAdapterInputs {
  readonly authorizer?: CapabilityAuthorizer;
  readonly dispatcher?: ExecutionDispatcher;
  readonly meteredDimensions?: readonly string[];
  /**
   * Per-flow non-deterministic calls, feeding the determinism rule (issue #82). Produce these
   * from `@loom/compiler`'s `analyzeNonDeterminism(runnerSource, flowId)` over the flow runner /
   * orchestration source — NOT step `handler$` bodies, which are memoized (their output is logged
   * and served on replay, so non-determinism inside them is already safe).
   */
  readonly nonDeterministicByFlow?: Readonly<Record<string, readonly NonDeterministicCall[]>>;
  /**
   * ADR 0061 — per-flow loop step-identity findings, feeding the determinism rule's
   * loop-identity warnings. Produce from `@loom/compiler`'s `analyzeLoopIdentity` (or read
   * the compiler manifest's per-flow `loopIdentity` field, which carries the same shape).
   */
  readonly loopIdentityByFlow?: Readonly<Record<string, readonly LoopIdentityCall[]>>;
}

/**
 * Project a resolved runtime + config pieces into a `VerifyInput` for `@loom/verify`.
 *
 * What we can derive today, and the honest limits:
 * - **flows / flowHash / effects** — from the registered `FlowDefinition`s. Each step's
 *   `toolId` is the required capability (Loom's 1:1 tool↔capability model), which powers
 *   the load-bearing **capability-compat** check against the `GrantTable`.
 * - **grants** — only when the authorizer is a `GrantTable` (its `view()` projection).
 *   A custom authorizer is opaque, so capability-compat is skipped (matches K2: unwired ⇒
 *   permissive).
 * - **placement** — only when the dispatcher is a `PlacementDispatcher` (its `targetNames`).
 * - **eventSchemaVersion** — the app's `EVENT_SCHEMA_VERSION`.
 *
 * Non-determinism analysis is fed via `inputs.nonDeterministicByFlow` (from
 * `@loom/compiler`'s `analyzeNonDeterminism`, issue #82). Still not derivable from the
 * definition: suspend-point `correlationKey`/`wakeAt` detail, per-flow `computeTarget`, budgets.
 */
export function resolveVerifyInput(
  runtime: WorkflowRuntime,
  inputs: VerifyAdapterInputs = {}
): VerifyInput {
  const flows: FlowSpec[] = [];
  for (const id of runtime.getFlowIds()) {
    const def = runtime.getFlow(id)?.definition;
    if (def === undefined) continue;
    const effects = def.steps
      .filter((s): s is typeof s & { toolId: string } => s.toolId !== undefined)
      .map((s) => ({ toolId: s.toolId, capability: s.toolId, kind: "step" as const }));
    const nonDet = inputs.nonDeterministicByFlow?.[def.id];
    const loopIdent = inputs.loopIdentityByFlow?.[def.id];
    // K10-R1 reachability: derived from the REAL step schemas here rather than supplied by a
    // caller, so the check cannot be skipped by forgetting to wire it. An app with no marks
    // stranded under records/unions/tuples yields an empty list and the rule is a no-op (G2).
    const unreachableMarks: UnreachableMarkRef[] = [];
    for (const step of def.steps) {
      for (const channel of ["input", "output"] as const) {
        const schema = channel === "input" ? step.inputSchema : step.outputSchema;
        if (schema === undefined) continue;
        for (const mark of collectUnreachableMarks(schema)) {
          unreachableMarks.push({
            path: mark.path,
            dataClass: mark.dataClass,
            container: mark.container,
            stepId: step.id,
            channel,
          });
        }
      }
    }
    flows.push({
      id: def.id,
      flowHash: flowContentHash(def),
      ...(effects.length > 0 && { effects }),
      ...(nonDet !== undefined && nonDet.length > 0 && { nonDeterministicCalls: nonDet }),
      ...(loopIdent !== undefined && loopIdent.length > 0 && { loopIdentityCalls: loopIdent }),
      ...(unreachableMarks.length > 0 && { unreachableMarks }),
    });
  }

  const grants: GrantSpec | undefined =
    inputs.authorizer instanceof GrantTable ? { grants: inputs.authorizer.view() } : undefined;
  const placement: PlacementSpec | undefined =
    inputs.dispatcher instanceof PlacementDispatcher
      ? { targets: inputs.dispatcher.targetNames }
      : undefined;

  return {
    flows,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    ...(grants !== undefined && { grants }),
    ...(placement !== undefined && { placement }),
    ...(inputs.meteredDimensions !== undefined && { meteredDimensions: inputs.meteredDimensions }),
  };
}
