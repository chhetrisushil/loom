import { collectUnreachableMarks } from "@loom/classify";
import { flowContentHash } from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { PlacementDispatcher } from "@loom/dispatcher";
import type { CapabilityAuthorizer } from "@loom/effect-runtime";
import { GrantTable } from "@loom/effect-runtime";
import { EVENT_SCHEMA_VERSION } from "@loom/replay-vm";
import { readReachDeclaration } from "@loom/verify";
import type {
  DeciderEffectRef,
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
  readonly steps?: readonly {
    readonly stepId?: string;
    readonly toolId: string;
    /** L31 — reached through `scope.invokeTransient` in a `ctx.decide` decider. */
    readonly viaDecider?: boolean;
  }[];
  readonly unresolved?: readonly UnresolvedReachRef[];
  readonly suspends?: readonly SuspendPoint[];
  /** L32 — `ctx` / `ctx.decide` handed to callees outside the analysed module. */
  readonly escapes?: readonly {
    readonly callee: string;
    readonly root?: string;
    readonly via: "ctx" | "decide";
    /** The ctx method handed over (`run` for `lib(ctx.run)`); absent for the whole ctx. */
    readonly member?: string;
    readonly location?: string;
  }[];
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
      /**
       * L32 — declared reach for code a flow hands its `ctx` to. Keys are the callee text
       * (`"planner.compose"`) or its leftmost identifier (`"planner"`) as written in the flow
       * source; values are the REAL objects (carrying a reach declaration, see `declareReach`
       * in `@loom/verify`) or a plain `{ run?, transient? }` literal. A `ctx` handed to a callee
       * with no entry is reported unresolved.
       */
      readonly reach?: Readonly<Record<string, unknown>>;
    };

export interface NormalizedVerify {
  readonly mode: VerifyMode;
  readonly meteredDimensions?: readonly string[];
  readonly effectClasses?: readonly string[];
  readonly rules?: readonly RuleName[];
  readonly lint?: VerifyLintInputs;
  readonly reach?: Readonly<Record<string, unknown>>;
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
    ...(v.reach !== undefined && { reach: v.reach }),
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
  /** L32 — see `VerifyConfig.reach`: callee text / root identifier -> declared-reach carrier. */
  readonly reachDeclarations?: Readonly<Record<string, unknown>>;
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
 * **`FlowSpec.suspends` is populated from `runnerReachByFlow` (ADR 0086), and only from
 * there.** Suspend points live in the runner BODY, not the definition, so this adapter
 * cannot see a `correlationKey` or `wakeAt` on its own — the compiler's reach analysis reads
 * them and the manifest carries them. The bound that remains is therefore about INPUT, not
 * about producers: without a manifest, `reach` is undefined, `suspends` is empty, and two of
 * `suspension-safety`'s three checks have nothing to read.
 *
 * `reachAnalyzed` marks which case a flow is in. Note that no rule reads it yet, so a flow
 * verified without a manifest reports clean on those checks rather than partially verified —
 * the one thing here that still overstates its coverage.
 */
export function resolveVerifyInput(
  runtime: WorkflowRuntime,
  inputs: VerifyAdapterInputs = {}
): VerifyInput {
  const flows: FlowSpec[] = [];
  const decls = inputs.reachDeclarations;
  for (const id of runtime.getFlowIds()) {
    const def = runtime.getFlow(id)?.definition;
    if (def === undefined) continue;
    const effects: {
      toolId: string;
      capability: string;
      kind: "step";
      effectClass?: string;
      viaDeclared?: string;
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
    const deciderEffects: DeciderEffectRef[] = [];
    const deciderSeen = new Set<string>();
    for (const step of reach?.steps ?? []) {
      if (step.viaDecider === true && !deciderSeen.has(step.toolId)) {
        deciderSeen.add(step.toolId);
        const mode = runtime.effectModeOf(step.toolId);
        deciderEffects.push({
          toolId: step.toolId,
          ...(mode !== undefined && { mode }),
          ...(!runtime.hasEffect(step.toolId) && { unregistered: true }),
        });
      }
      if (declaredToolIds.has(step.toolId)) continue; // already covered by the declaration
      declaredToolIds.add(step.toolId);
      effects.push({
        toolId: step.toolId,
        capability: step.toolId,
        kind: "step" as const,
      });
    }

    // R3 — the OTHER way a capability is reachable without being a declared step:
    // a menu behind one step. An `agentStep$` is a single step whose loop may call
    // any tool in the agent's `tools`, chosen by a model at run time; an A2A step
    // is the same shape over a peer's skills. Read from the REAL step definitions,
    // like everything else here, so the check cannot be satisfied by a caller who
    // simply declines to declare the menu.
    //
    // These effects carry NO effectClass, and that is the point: a class lives on a
    // step declaration and there is no per-tool one to inherit, so the flow lands in
    // ADR 0084's "N reachable effects carry no class" warn instead of passing
    // vacuously. Partially verified is the honest report; silently clean was not.
    for (const step of def.steps) {
      for (const reachable of step.reachableTools ?? []) {
        if (declaredToolIds.has(reachable.id)) continue;
        declaredToolIds.add(reachable.id);
        effects.push({
          toolId: reachable.id,
          capability: reachable.id,
          kind: (reachable.kind ?? "step") as "step",
        });
      }
    }
    // L32 — `ctx` handed to code outside the module. The compiler recorded WHERE; the app's
    // `verify.reach` maps that callee to the real object, whose declaration is read here. Own
    // keys only (a callee named `constructor` must not resolve to Object's).
    const unresolvedReach: UnresolvedReachRef[] = [...(reach?.unresolved ?? [])];
    for (const esc of reach?.escapes ?? []) {
      const pick = (k: string | undefined): unknown =>
        k !== undefined && decls !== undefined && Object.hasOwn(decls, k) ? decls[k] : undefined;
      const decl = readReachDeclaration(pick(esc.callee) ?? pick(esc.root));
      if (decl === undefined) {
        const handed =
          esc.via === "decide"
            ? "ctx.decide"
            : esc.member !== undefined
              ? `ctx.${esc.member}`
              : "ctx";
        unresolvedReach.push({
          expr: `${handed} handed to ${esc.callee} (no declared reach; add verify.reach["${esc.root ?? esc.callee}"])`,
          kind: "step",
          ...(esc.location !== undefined && { location: esc.location }),
        });
        continue;
      }
      const add = (toolId: string, transient: boolean): void => {
        // A declaration is explicit: a tool it names that is not registered is a typo or a
        // stale declaration, so it is reported (warn), not quietly counted.
        if (!runtime.hasEffect(toolId)) {
          const expr = `declared ${transient ? "transient " : ""}tool "${toolId}" (declared for ${esc.callee}) is not registered`;
          if (!unresolvedReach.some((u) => u.expr === expr)) {
            unresolvedReach.push({
              expr,
              kind: "step",
              ...(esc.location !== undefined && { location: esc.location }),
            });
          }
        }
        if (transient && !deciderSeen.has(toolId)) {
          deciderSeen.add(toolId);
          const mode = runtime.effectModeOf(toolId);
          deciderEffects.push({
            toolId,
            ...(mode !== undefined && { mode }),
            ...(!runtime.hasEffect(toolId) && { unregistered: true }),
            viaDeclared: esc.callee,
          });
        }
        if (declaredToolIds.has(toolId)) return;
        declaredToolIds.add(toolId);
        effects.push({
          toolId,
          capability: toolId,
          kind: "step" as const,
          viaDeclared: esc.callee,
        });
      };
      for (const t of decl.run ?? []) add(t, false);
      for (const t of decl.transient ?? []) add(t, true);
    }
    const suspends = reach?.suspends ?? [];

    flows.push({
      id: def.id,
      flowHash: flowContentHash(def),
      ...(effects.length > 0 && { effects }),
      ...(reach !== undefined && { reachAnalyzed: true }),
      ...(unresolvedReach.length > 0 && { unresolvedReach }),
      ...(suspends.length > 0 && { suspends }),
      ...(deciderEffects.length > 0 && { deciderEffects }),
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
