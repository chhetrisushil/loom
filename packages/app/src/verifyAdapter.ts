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
  SuspendPoint,
  UnreachableMarkRef,
  UnresolvedReachRef,
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
  /**
   * Runner-body reach analysis, from `@loom/compiler`'s `analyzeRunnerReach`.
   *
   * Supplies the two things the `FlowDefinition` structurally cannot: steps
   * invoked via `ctx.run` without being declared in `steps`, and the suspend
   * points that `FlowSpec.suspends` had no producer for. A flow present in this
   * map is marked `reachAnalyzed`, which is what lets the rules distinguish
   * "analyzed and complete" from "never analyzed".
   */
  readonly runnerReachByFlow?: Readonly<Record<string, RunnerReachInput>>;
}

/**
 * Structural mirror of `@loom/compiler`'s `RunnerReach`. Declared here so
 * `@loom/app` does not depend on the compiler (which is a build-time tool), the
 * same way `NonDeterministicCall` already arrives.
 */
export interface RunnerReachInput {
  readonly steps?: readonly { readonly stepId?: string; readonly toolId: string }[];
  readonly unresolved?: readonly UnresolvedReachRef[];
  readonly suspends?: readonly SuspendPoint[];
}

export type VerifyConfig =
  | VerifyMode
  | {
      readonly mode?: VerifyMode;
      /** Dimensions the wired metering covers (e.g. `["tokens","costUsd","ms"]`). */
      readonly meteredDimensions?: readonly string[];
      /** Restrict to a subset of rules; defaults to all. */
      readonly rules?: readonly RuleName[];
      /**
       * EF — the app's effect-class vocabulary, **ascending severity**, e.g.
       * `["read-only","local-write","external-write","irreversible"]`. Declaring it
       * turns on the `effect-class` rule; omitting it keeps the rule a no-op (G2).
       * The taxonomy is yours: loom checks the ordering you supply, it does not
       * define one (ADR 0083).
       */
      readonly effectClasses?: readonly string[];
      /** Compiler lint findings (nondeterminism issue #82, loop identity ADR 0061). */
      readonly lint?: VerifyLintInputs;
    };

export interface NormalizedVerify {
  readonly mode: VerifyMode;
  readonly meteredDimensions?: readonly string[];
  readonly effectClasses?: readonly string[];
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
    ...(v.effectClasses !== undefined && { effectClasses: v.effectClasses }),
    ...(v.lint !== undefined && { lint: v.lint }),
  };
}

export interface VerifyAdapterInputs {
  readonly authorizer?: CapabilityAuthorizer;
  /**
   * EF — the app's effect-class vocabulary, ascending severity. Supplied because
   * the taxonomy is a product decision, not loom's (ADR 0083). Absent ⇒ the
   * effect-class rule is a no-op.
   */
  readonly effectClasses?: readonly string[];
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
   * Per-flow runner-body reach, from `@loom/compiler`'s `analyzeRunnerReach`.
   * Supplies steps invoked via `ctx.run` that the `FlowDefinition` does not
   * declare, the suspend points `FlowSpec.suspends` had no producer for, and the
   * targets the analysis could NOT resolve — which is what lets the reach-bounded
   * rules state their own limit instead of reporting clean.
   */
  readonly runnerReachByFlow?: Readonly<Record<string, RunnerReachInput>>;
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
 * - **usesApproval / resumeAuthenticatorWired** — the flow's declared `resumeSchemas`, and
 *   whether the runtime holds a `ResumeAuthenticator`. Both are read here rather than
 *   accepted as inputs, so the K12 check cannot be silenced by a caller that forgets — or
 *   satisfied by one that merely claims to have wired it.
 *
 * Non-determinism analysis is fed via `inputs.nonDeterministicByFlow` (from
 * `@loom/compiler`'s `analyzeNonDeterminism`, issue #82). Still not derivable from the
 * definition: per-flow `computeTarget` and budgets.
 *
 * **`FlowSpec.suspends` is still unpopulated, and that matters.** Suspend points live in
 * the runner BODY, not the definition, so nothing here can see their `correlationKey` or
 * `wakeAt`. Two of `suspension-safety`'s three checks read that array and therefore never
 * fire for any app built through this adapter — a clean report says nothing about them.
 * Only the K12 approval check above is live. Populating it needs body analysis of the
 * same kind `nonDeterministicByFlow` already arrives by.
 */
export function resolveVerifyInput(
  runtime: WorkflowRuntime,
  inputs: VerifyAdapterInputs = {}
): VerifyInput {
  const flows: FlowSpec[] = [];
  for (const id of runtime.getFlowIds()) {
    const def = runtime.getFlow(id)?.definition;
    if (def === undefined) continue;
    const effects: {
      toolId: string;
      capability: string;
      kind: "step";
      effectClass?: string;
    }[] = def.steps
      .filter((s): s is typeof s & { toolId: string } => s.toolId !== undefined)
      .map((s) => ({
        toolId: s.toolId,
        capability: s.toolId,
        kind: "step" as const,
        // EF — read from the REAL step definition, never accepted from a caller, so
        // the effect-class rule cannot be satisfied by an app that merely claims a
        // class (same discipline as unreachableMarks / usesApproval below).
        ...(s.effectClass !== undefined && { effectClass: s.effectClass }),
      }));
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
    // K12 — a flow declaring resume gates (`resumeSchemas`, ADR 0077) can be advanced by
    // an externally-supplied event, so the suspension-safety rule wants a
    // ResumeAuthenticator behind it. Derived here, like `unreachableMarks` above, rather
    // than accepted from the caller.
    //
    // CONSERVATIVE, and knowingly so: `resumeSchemas` is opt-in, so a flow that suspends
    // without declaring gate contracts still reports nothing. That direction is the safe
    // one — this never invents a finding for a flow that cannot be resumed — but it does
    // mean a clean report is not proof that no flow resumes. Closing that needs static
    // analysis of the runner body, which is also what `FlowSpec.suspends` waits on; see
    // the note on `resolveVerifyInput`.
    const usesApproval = Object.keys(def.resumeSchemas ?? {}).length > 0;

    // Runner-body reach (issue: the "reachable = DECLARED steps" bound). A step
    // invoked through `ctx.run` without being listed in `steps` is invisible to
    // capability-compat and effect-class; a suspend point is invisible to
    // suspension-safety no matter what, because it lives in the body by
    // construction. Merge what the analysis resolved, and carry what it could
    // NOT resolve so the rules can bound their own claim.
    const reach = inputs.runnerReachByFlow?.[def.id];
    const declaredToolIds = new Set(effects.map((e) => e.toolId));
    for (const step of reach?.steps ?? []) {
      if (declaredToolIds.has(step.toolId)) continue; // already covered by the declaration
      declaredToolIds.add(step.toolId);
      effects.push({
        toolId: step.toolId,
        capability: step.toolId,
        kind: "step" as const,
      });
    }
    const unresolvedReach = reach?.unresolved ?? [];
    const suspends = reach?.suspends ?? [];

    flows.push({
      id: def.id,
      flowHash: flowContentHash(def),
      ...(effects.length > 0 && { effects }),
      ...(reach !== undefined && { reachAnalyzed: true }),
      ...(unresolvedReach.length > 0 && { unresolvedReach }),
      ...(suspends.length > 0 && { suspends }),
      ...(def.effectClass !== undefined && { effectClass: def.effectClass }),
      ...(nonDet !== undefined && nonDet.length > 0 && { nonDeterministicCalls: nonDet }),
      ...(loopIdent !== undefined && loopIdent.length > 0 && { loopIdentityCalls: loopIdent }),
      ...(unreachableMarks.length > 0 && { unreachableMarks }),
      ...(usesApproval && { usesApproval }),
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
    resumeAuthenticatorWired: runtime.hasResumeAuthenticator(),
    timerStoreWired: runtime.hasTimerStore(),
    ...(grants !== undefined && { grants }),
    ...(placement !== undefined && { placement }),
    ...(inputs.meteredDimensions !== undefined && { meteredDimensions: inputs.meteredDimensions }),
    ...(inputs.effectClasses !== undefined && { effectClasses: inputs.effectClasses }),
  };
}
