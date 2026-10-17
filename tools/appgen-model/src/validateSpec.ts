import type { AppModel, ChangeSpec } from "@loom/appgen";

// Semantic validation of a model-produced ChangeSpec against the scanned app. The
// grammar already guarantees the JSON is well-formed and on-schema; this catches the
// mistakes a model still makes — referencing a flow/step that doesn't exist, using
// `create` for something that's already there, malformed ids. The issue list drives the
// self-repair loop (re-prompt the model with what was wrong).

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

export function validateChangeSpec(spec: ChangeSpec, appModel: AppModel): string[] {
  const issues: string[] = [];
  const flowIds = new Set(appModel.flows.map((f) => f.id));
  const stepsByFlow = new Map(appModel.flows.map((f) => [f.id, new Set(f.steps.map((s) => s.id))]));

  // Step ids are unique PER FLOW (a step id is the key inside one flow's execution; the
  // runtime does not require them to be unique across flows). Tracked across every
  // operation on the same flow so two ops cannot both touch one id.
  const seenByFlow = new Map<string, Set<string>>();

  if (spec.capabilities.length === 0) issues.push("the plan has no capabilities — it is empty");

  for (const cap of spec.capabilities) {
    if (!KEBAB.test(cap.id)) issues.push(`capability id "${cap.id}" must be kebab-case`);
    const exists = flowIds.has(cap.id);
    if (cap.op === "create" && exists) {
      issues.push(`flow "${cap.id}" already exists — use op "extend", not "create"`);
    }
    if ((cap.op === "extend" || cap.op === "modify" || cap.op === "delete") && !exists) {
      issues.push(`op "${cap.op}" targets flow "${cap.id}", but no such flow exists`);
    }
    const known = stepsByFlow.get(cap.id);
    let seen = seenByFlow.get(cap.id);
    if (seen === undefined) {
      seen = new Set();
      seenByFlow.set(cap.id, seen);
    }
    for (const step of cap.steps) {
      if (seen.has(step.id)) {
        issues.push(
          `flow "${cap.id}" declares step id "${step.id}" more than once — step ids must be unique within a flow; use each id once`
        );
        continue;
      }
      seen.add(step.id);
      if (!KEBAB.test(step.id))
        issues.push(`step id "${step.id}" in "${cap.id}" must be kebab-case`);
      if (
        (step.op === "modify" || step.op === "delete") &&
        known !== undefined &&
        !known.has(step.id)
      ) {
        issues.push(`step "${step.id}" op "${step.op}" but flow "${cap.id}" has no such step`);
      }
      if (step.op === "create" && known !== undefined && known.has(step.id)) {
        issues.push(`step "${step.id}" already exists in "${cap.id}" — use op "modify"`);
      }
    }
  }
  return issues;
}
