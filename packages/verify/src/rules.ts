import type { Finding, RuleName, VerifyInput } from "./types";

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
 * suspension-safety — every suspend needs a correlationKey to route its resume; a timed
 * suspend needs a durable wakeAt to fire across a restart (T1); approval flows need a
 * ResumeAuthenticator so resume events are authenticated (K12).
 */
const suspensionSafety: Rule = (input) => {
  const findings: Finding[] = [];
  for (const flow of input.flows) {
    for (const s of flow.suspends ?? []) {
      const where = s.id ? `${flow.id}:${s.id}` : flow.id;
      if (!s.correlationKey) {
        findings.push({
          rule: "suspension-safety",
          severity: "error",
          message: `suspend() in "${where}" declares no correlationKey; a resume event cannot be routed to it.`,
          location: where,
        });
      }
      if (s.timed && !s.wakeAt) {
        findings.push({
          rule: "suspension-safety",
          severity: "error",
          message: `Timed suspend in "${where}" records no wakeAt; the timer will not fire across a restart (T1).`,
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
  for (const flow of input.flows) {
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

/** Two schema versions are compatible iff they share a major version. */
function majorCompatible(a: string, b: string): boolean {
  return (a.split(".")[0] ?? a) === (b.split(".")[0] ?? b);
}

/** All rules, keyed by name. */
export const RULES: Record<RuleName, Rule> = {
  determinism,
  "replay-safety": replaySafety,
  "suspension-safety": suspensionSafety,
  "capability-compat": capabilityCompat,
  "placement-compat": placementCompat,
  "resource-compat": resourceCompat,
  "classification-reachability": classificationReachability,
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
];
