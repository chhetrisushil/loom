import type { Finding, FlowSpec, RuleName, VerifyInput } from "./types";

/** A rule is a pure function of the input to a (possibly empty) list of findings. */
export type Rule = (input: VerifyInput) => Finding[];

/**
 * determinism — flag non-deterministic calls reachable outside a `ctx.decide`/`ctx.execute`
 * boundary. On replay these produce different values than were folded, so P2 breaks.
 */
const determinism: Rule = (input) => {
  const findings: Finding[] = [];
  for (const flow of input.flows) {
    for (const call of flow.nonDeterministicCalls ?? []) {
      if (!call.insideDecide) {
        findings.push({
          rule: "determinism",
          severity: "error",
          message: `Non-deterministic call ${call.callee} is reachable outside ctx.decide/ctx.execute; replay will diverge (P2). Wrap it in ctx.decide.`,
          location: call.location ?? flow.id,
        });
      }
    }
    // ADR 0061 — the step-identity rule. A syntactic heuristic, so `warn`:
    // a reused id inside a loop is served iteration 0's memoized output.
    for (const call of flow.loopIdentityCalls ?? []) {
      findings.push({
        rule: "determinism",
        severity: "warn",
        message: `ctx.${call.callee} inside ${call.loopKind} uses a step id that cannot vary per iteration (${call.reason}); frames are keyed by id, so later iterations replay iteration 0's output. Mint \`\${id}#\${index}\` (ADR 0061).`,
        location: call.location ?? flow.id,
      });
    }
  }
  return findings;
};

/**
 * replay-safety — a flow must carry a content hash (K11) so an in-flight execution can be
 * pinned to its code version, and the app's event schema must be compatible with any prior
 * log it may resume (K5).
 */
const replaySafety: Rule = (input) => {
  const findings: Finding[] = [];
  for (const flow of input.flows) {
    if (!flow.flowHash) {
      findings.push({
        rule: "replay-safety",
        severity: "error",
        message: `Flow "${flow.id}" has no content hash (K11); an in-flight execution cannot be pinned to its code version and may silently fold old logs with new code.`,
        location: flow.id,
      });
    }
  }
  const app = input.eventSchemaVersion;
  const log = input.resumeLogSchemaVersion;
  if (app && log && !majorCompatible(app, log)) {
    findings.push({
      rule: "replay-safety",
      severity: "error",
      message: `Event schema ${app} is incompatible with prior log schema ${log} (K5 major mismatch); resuming may misfold.`,
    });
  }
  return findings;
};

/**
 * suspension-safety — a timed suspend must be able to wake across a restart (T1);
 * approval flows need a ResumeAuthenticator so resume events are authenticated (K12).
 *
 * **Two corrections landed when `FlowSpec.suspends` finally got a producer**, and
 * both are worth stating because a check nothing populates is also a check
 * nobody can see is wrong.
 *
 * 1. *The blanket correlationKey error was removed.* It read "a resume event
 *    cannot be routed to it" — but `WorkflowRuntime.resume(executionId, event)`
 *    routes by **executionId**, and nothing in the runtime matches on
 *    `correlationKey` at all. It is metadata for an external dispatcher that
 *    knows a business key instead of an execution id. Every idiomatic
 *    `ctx.suspend({ on: "Approved" })` would have become an error the moment the
 *    input was populated — a false positive on the majority of real code, which
 *    is how a verifier gets switched off.
 * 2. *The wakeAt check is now conditional on the timer store.* When a `TimerStore`
 *    is wired, `WorkflowRuntime` DERIVES `wakeAt` from `timeout` at suspend time,
 *    so `suspend({ on, timeout })` is correct there and broken only without one.
 */
const suspensionSafety: Rule = (input) => {
  const findings: Finding[] = [];
  findings.push(
    ...unanalysedCoverage(
      input.flows,
      "suspension-safety",
      "no suspend point is visible at all — suspends live in the runner body, so timed-suspend safety is UNVERIFIED rather than clean (a flow that never suspends is unaffected)"
    )
  );
  for (const flow of input.flows) {
    // Only suspend-shaped gaps matter here: an unresolvable `ctx.run` target
    // says nothing about whether this flow's suspends are safe.
    const unresolvedSuspends = (flow.unresolvedReach ?? []).filter((u) => u.kind === "suspend");
    if (unresolvedSuspends.length > 0) {
      findings.push({
        rule: "suspension-safety",
        severity: "warn",
        message: `Flow "${flow.id}": ${unresolvedSuspends.length} suspend condition(s) are built outside the call and could not be read statically; their timer safety is unverified.`,
        location: flow.id,
      });
    }
    for (const s of flow.suspends ?? []) {
      const where = s.id ? `${flow.id}:${s.id}` : flow.id;
      if (s.timed && !s.wakeAt && input.timerStoreWired !== true) {
        findings.push({
          rule: "suspension-safety",
          severity: "error",
          message: `Timed suspend in "${where}" declares a timeout but no wakeAt, and no TimerStore is wired to derive one; the timer will not fire across a restart (T1).`,
          location: where,
        });
      }
    }
    if (flow.usesApproval && !input.resumeAuthenticatorWired) {
      findings.push({
        rule: "suspension-safety",
        severity: "error",
        message: `Flow "${flow.id}" uses approval/resume but no ResumeAuthenticator is wired (K12); resume events would be unauthenticated.`,
        location: flow.id,
      });
    }
  }
  return findings;
};

/**
 * capability-compat — every effect a flow invokes must have a matching grant in the GrantTable
 * (K2). Skipped entirely when no GrantTable is wired (G2: unwired behavior is unchanged).
 */
const capabilityCompat: Rule = (input) => {
  const findings: Finding[] = [];
  const grantSpec = input.grants;
  if (!grantSpec) return findings;
  findings.push(
    ...unanalysedCoverage(
      input.flows,
      "capability-compat",
      "grant coverage is checked only over their DECLARED steps — a tool invoked through `ctx.run` without being declared is invisible here"
    )
  );
  for (const flow of input.flows) {
    findings.push(...reachCoverage(flow, "capability-compat", "grant coverage"));
    const principal = grantSpec.principalOf ? grantSpec.principalOf(flow.id) : flow.id;
    const granted = grantSpec.grants[principal];
    for (const effect of flow.effects ?? []) {
      if (granted === "*") continue;
      if (!granted || !granted.includes(effect.capability)) {
        findings.push({
          rule: "capability-compat",
          severity: "error",
          message: `Flow "${flow.id}" invokes "${effect.toolId}" requiring capability "${effect.capability}", which is not granted to principal "${principal}" (K2).`,
          location: `${flow.id}:${effect.toolId}`,
        });
      }
    }
  }
  return findings;
};

/**
 * placement-compat — a pinned computeTarget must resolve to a registered dispatcher target,
 * and (when declared) that target must support the flow's effect kinds.
 */
const placementCompat: Rule = (input) => {
  const findings: Finding[] = [];
  const placement = input.placement;
  for (const flow of input.flows) {
    const target = flow.computeTarget;
    if (!target) continue;
    if (!placement) {
      findings.push({
        rule: "placement-compat",
        severity: "error",
        message: `Flow "${flow.id}" pins computeTarget "${target}" but no PlacementDispatcher targets are registered.`,
        location: flow.id,
      });
      continue;
    }
    if (!placement.targets.includes(target)) {
      findings.push({
        rule: "placement-compat",
        severity: "error",
        message: `Flow "${flow.id}" pins computeTarget "${target}", not a registered dispatcher target [${placement.targets.join(", ")}].`,
        location: flow.id,
      });
      continue;
    }
    const supported = placement.supportedKinds?.[target];
    if (supported) {
      for (const effect of flow.effects ?? []) {
        if (effect.kind && !supported.includes(effect.kind)) {
          findings.push({
            rule: "placement-compat",
            severity: "warn",
            message: `Target "${target}" for flow "${flow.id}" does not declare support for effect kind "${effect.kind}" (tool "${effect.toolId}").`,
            location: `${flow.id}:${effect.toolId}`,
          });
        }
      }
    }
  }
  return findings;
};

/**
 * resource-compat — a declared budget dimension must actually be metered (K3), and a budget
 * without a ceiling cannot be enforced.
 */
const resourceCompat: Rule = (input) => {
  const findings: Finding[] = [];
  const metered = new Set(input.meteredDimensions ?? []);
  for (const flow of input.flows) {
    const budget = flow.budget;
    if (!budget) continue;
    for (const dim of budget.dimensions) {
      if (!metered.has(dim)) {
        findings.push({
          rule: "resource-compat",
          severity: "error",
          message: `Flow "${flow.id}" declares a "${dim}" budget but no metering covers that dimension (K3); the budget is inert.`,
          location: flow.id,
        });
      }
      if (!budget.ceilings || budget.ceilings[dim] === undefined) {
        findings.push({
          rule: "resource-compat",
          severity: "warn",
          message: `Flow "${flow.id}" budget dimension "${dim}" has no ceiling; a quota cannot be enforced.`,
          location: flow.id,
        });
      }
    }
  }
  return findings;
};

/**
 * classification-reachability — a `secret()`/`sensitive()`/`internal()` mark that no egress
 * sink can address (K10-R1 / K10-R6).
 *
 * The dot-path sinks — telemetry scrubbing, field-level encryption, content externalization —
 * walk objects and arrays. They do NOT descend into a record's values, a union's branches, a
 * tuple's members or an intersection's sides. A mark placed under one of those collects no
 * path and does nothing: the field is not masked on egress, not encrypted at rest, not
 * externalized. The developer marked it and nothing said otherwise.
 *
 * `error`, not `warn`: the failure is silent, and the consequence is classified data leaving
 * the trust boundary in the clear. The fix is to mark the container itself — which covers the
 * subtree as a unit — or to restructure it as an object or array, both of which are walked.
 */
const classificationReachability: Rule = (input) => {
  const findings: Finding[] = [];
  for (const flow of input.flows) {
    for (const mark of flow.unreachableMarks ?? []) {
      findings.push({
        rule: "classification-reachability",
        severity: "error",
        message: `\`${mark.dataClass}()\` on "${mark.path}" (${mark.stepId} ${mark.channel}) sits under a \`${mark.container}\`, which no egress sink can address — it is masked nowhere, encrypted nowhere, externalized nowhere. Mark the \`${mark.container}\` itself instead, or restructure it as an object or array (K10-R1).`,
        location: `${flow.id}:${mark.stepId}`,
      });
    }
  }
  return findings;
};

/**
 * The reach bound, stated as a finding instead of left implicit.
 *
 * `capability-compat`, `effect-class` and `suspension-safety` all answer a
 * question of the form "does everything this flow reaches satisfy X". Each is
 * only as good as the set of things known to be reachable, and that set has two
 * holes: a `ctx.run` target static analysis could not resolve, and a runner that
 * was never analyzed at all.
 *
 * Silence about the bound is what turns a green report into an overclaim — the
 * same failure the `effect-class` unclassified-effects warn exists to prevent.
 * `warn`, not `error`: an unresolved target is a limit of the analysis, not a
 * defect in the app, and an app with no compiler wired must stay usable.
 */
/**
 * V1/V2 — the coverage a rule does NOT have when the runner bodies were never read.
 *
 * `reachAnalyzed` marks a flow whose body the compiler analysed (ADR 0086). Without a
 * manifest it is absent, `FlowSpec.suspends` is empty and `effects` holds only DECLARED
 * steps — and until now every rule reported exactly as it does with full coverage. The
 * field was written by the adapter and read by nothing, which is how a verifier ends up
 * saying "0 errors" about code it never looked at.
 *
 * One finding per RULE, not per flow: the same fact repeated twenty times is noise, and
 * noise is how a verifier gets switched off. `info` for the same reason — the compiler is
 * opt-in, so a `warn` would scold every correct project that simply does not use it.
 */
function unanalysedCoverage(
  flows: readonly FlowSpec[],
  rule: RuleName,
  consequence: string
): Finding[] {
  const blind = flows.filter((f) => f.reachAnalyzed !== true);
  if (blind.length === 0) return [];
  const sample = blind
    .slice(0, 3)
    .map((f) => `"${f.id}"`)
    .join(", ");
  const more = blind.length > 3 ? `, +${blind.length - 3} more` : "";
  return [
    {
      rule,
      severity: "info",
      message: `${blind.length} of ${flows.length} flow(s) had no runner-body analysis (${sample}${more}), so ${consequence}. Build with @loom/compiler and pass its manifest to cover them (ADR 0086).`,
    },
  ];
}

function reachCoverage(flow: FlowSpec, rule: RuleName, what: string): Finding[] {
  const unresolved = flow.unresolvedReach ?? [];
  if (unresolved.length > 0) {
    const sample = unresolved
      .slice(0, 3)
      .map((u) => `\`${u.expr}\``)
      .join(", ");
    const more = unresolved.length > 3 ? `, +${unresolved.length - 3} more` : "";
    return [
      {
        rule,
        severity: "warn",
        message: `Flow "${flow.id}": ${unresolved.length} runner-body target(s) could not be resolved (${sample}${more}), so ${what} is checked only over what is declared or resolvable.`,
        location: flow.id,
      },
    ];
  }
  return [];
}

/** Two schema versions are compatible iff they share a major version. */
function majorCompatible(a: string, b: string): boolean {
  return (a.split(".")[0] ?? a) === (b.split(".")[0] ?? b);
}

/** All rules, keyed by name. */
/**
 * effect-class (EF) — a flow may not reach an effect whose declared class exceeds
 * the class the flow itself declared. Static, whole-flow, conservative by
 * composition: the flow's effective class is the max over everything it reaches.
 *
 * The class VOCABULARY is app-supplied (`input.effectClasses`, ascending
 * severity). Loom owns the mechanism, not the taxonomy — what the classes ARE is
 * a product decision (ADR 0083).
 *
 * **K2 reconciliation.** The `GrantTable` is an INDEPENDENT protection ring. It
 * answers "may this principal invoke this tool at all"; it never answers "does
 * this tool exceed what the flow promised". So a granted effect that busts the
 * declared class is invisible to K2 — the finding says so explicitly, because
 * that is precisely why this rule exists beside `capability-compat` rather than
 * inside it. Static class = declared upper bound; grants = runtime floor.
 */
const effectClass: Rule = (input) => {
  const findings: Finding[] = [];
  const order = input.effectClasses;
  if (order === undefined || order.length === 0) return findings; // G2: unwired ⇒ no-op
  const rank = new Map(order.map((c, i) => [c, i]));
  const ladder = order.join(" < ");

  const grantSpec = input.grants;
  /** true = granted, false = denied, undefined = no GrantTable wired (K2 permissive). */
  const grantedTo = (flowId: string, capability: string): boolean | undefined => {
    if (grantSpec === undefined) return undefined;
    const principal = grantSpec.principalOf ? grantSpec.principalOf(flowId) : flowId;
    const granted = grantSpec.grants[principal];
    if (granted === "*") return true;
    return granted === undefined ? false : granted.includes(capability);
  };

  findings.push(
    ...unanalysedCoverage(
      input.flows,
      "effect-class",
      "the declared ceiling is checked only over their DECLARED steps, so an undeclared `ctx.run` target cannot raise it"
    )
  );

  for (const flow of input.flows) {
    const declared = flow.effectClass;
    if (declared === undefined) continue; // opt-in per flow (G2)
    const declaredRank = rank.get(declared);
    if (declaredRank === undefined) {
      findings.push({
        rule: "effect-class",
        severity: "error",
        message: `Flow "${flow.id}" declares effect class "${declared}", which is not in the configured ordering [${ladder}].`,
        location: flow.id,
      });
      continue;
    }

    let unclassified = 0;
    for (const effect of flow.effects ?? []) {
      const ec = effect.effectClass;
      if (ec === undefined) {
        unclassified += 1;
        continue;
      }
      const effectRank = rank.get(ec);
      if (effectRank === undefined) {
        findings.push({
          rule: "effect-class",
          severity: "error",
          message: `Effect "${effect.toolId}" declares effect class "${ec}", which is not in the configured ordering [${ladder}].`,
          location: `${flow.id}:${effect.toolId}`,
        });
        continue;
      }
      if (effectRank > declaredRank) {
        const granted = grantedTo(flow.id, effect.capability);
        const k2 =
          granted === true
            ? " The capability IS granted, so K2 will not stop it at runtime — this check is the only thing that will."
            : granted === false
              ? " (K2 would also deny it: the capability is not granted to this principal.)"
              : "";
        findings.push({
          rule: "effect-class",
          severity: "error",
          message: `Flow "${flow.id}" declares effect class "${declared}" but reaches "${effect.toolId}", classed "${ec}".${k2}`,
          location: `${flow.id}:${effect.toolId}`,
        });
      }
    }

    findings.push(...reachCoverage(flow, "effect-class", "the declared ceiling"));

    // Without this the rule passes VACUOUSLY on a flow whose effects carry no
    // class — a green report would claim a verification nobody performed.
    if (unclassified > 0) {
      findings.push({
        rule: "effect-class",
        severity: "warn",
        message: `Flow "${flow.id}" declares effect class "${declared}", but ${unclassified} reachable effect(s) carry no class — the declaration is only partially verified.`,
        location: flow.id,
      });
    }
  }
  return findings;
};

export const RULES: Record<RuleName, Rule> = {
  determinism,
  "replay-safety": replaySafety,
  "suspension-safety": suspensionSafety,
  "capability-compat": capabilityCompat,
  "placement-compat": placementCompat,
  "resource-compat": resourceCompat,
  "classification-reachability": classificationReachability,
  "effect-class": effectClass,
};

/** Canonical rule order (matches ADR 0028). */
export const RULE_ORDER: readonly RuleName[] = [
  "determinism",
  "replay-safety",
  "suspension-safety",
  "capability-compat",
  "placement-compat",
  "resource-compat",
  "classification-reachability",
  "effect-class",
];
