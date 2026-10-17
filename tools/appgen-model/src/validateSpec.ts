import {
  type AppModel,
  type ChangeSpec,
  MAX_GRANTS,
  MAX_INTENT_LENGTH,
  MAX_LABEL_LENGTH,
  specStructureIssues,
  textIssues,
  textListIssues,
} from "@loom/appgen";

// Semantic validation of a model-produced ChangeSpec against the scanned app. The
// grammar already guarantees the JSON is well-formed and on-schema; this catches the
// mistakes a model still makes — referencing a flow/step that doesn't exist, using
// `create` for something that's already there, malformed ids. The issue list drives the
// self-repair loop (re-prompt the model with what was wrong).

// Id shapes, structure (duplicate / colliding ids) and the free-text rules are shared with
// `readLockfile` (a `--from-spec` replay never goes through this validator), so both gates
// apply identical predicates from ONE implementation (`specStructureIssues`, `textIssues`).

export { MAX_INTENT_LENGTH };

const DELETE_VERB = /\b(delete|remove|drop|get rid of|discard|retire|deprecate|unregister)\b/i;

/**
 * `request` is the USER'S request (the intent handed to the planner). A model-planned delete
 * (a flow or a step) is only accepted when that text asks for one. When a caller has no request
 * to hand (a structural-only check), the delete gate is skipped.
 */
export function validateChangeSpec(
  spec: ChangeSpec,
  appModel: AppModel,
  request?: string
): string[] {
  const issues: string[] = [];
  const asked = request === undefined || DELETE_VERB.test(request);
  const existing = new Map(appModel.flows.map((f) => [f.id, new Set(f.steps.map((s) => s.id))]));

  if (spec.capabilities.length === 0) issues.push("the plan has no capabilities — it is empty");
  issues.push(...textIssues("plan name", spec.name, MAX_LABEL_LENGTH));
  issues.push(...textIssues("compute target", spec.compute?.target, MAX_LABEL_LENGTH));

  for (const cap of spec.capabilities) {
    if (!asked) {
      const deletes = cap.op === "delete" || cap.steps.some((st) => st.op === "delete");
      if (deletes) {
        issues.push(
          `op "delete" on "${cap.id}" but the request does not ask to delete anything — only delete what the user explicitly asks to remove`
        );
      }
    }
    issues.push(...textIssues(`intent of "${cap.id}"`, cap.intent, MAX_INTENT_LENGTH));
    issues.push(...textIssues(`name of "${cap.id}"`, cap.name, MAX_LABEL_LENGTH));
    issues.push(
      ...textIssues(
        `reasoning base model of "${cap.id}"`,
        cap.reasoning?.baseModel,
        MAX_LABEL_LENGTH
      )
    );
    for (const m of cap.reasoning?.elevateTo ?? []) {
      issues.push(...textIssues(`reasoning elevation model of "${cap.id}"`, m, MAX_LABEL_LENGTH));
    }
    issues.push(
      ...textListIssues(`wireGrants of "${cap.id}"`, cap.wireGrants, MAX_LABEL_LENGTH, MAX_GRANTS)
    );
  }
  issues.push(...specStructureIssues(spec, existing));
  return issues;
}
