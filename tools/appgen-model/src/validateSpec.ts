import type { AppModel, ChangeSpec } from "@loom/appgen";
import { hasUnsafeChars } from "@loom/appgen";

// Semantic validation of a model-produced ChangeSpec against the scanned app. The
// grammar already guarantees the JSON is well-formed and on-schema; this catches the
// mistakes a model still makes — referencing a flow/step that doesn't exist, using
// `create` for something that's already there, malformed ids. The issue list drives the
// self-repair loop (re-prompt the model with what was wrong).

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

/** Longest free-text field a plan may carry (an intent is a sentence, not a document). */
export const MAX_INTENT_LENGTH = 500;
const MAX_LABEL_LENGTH = 200;

// Free text is escaped at every codegen sink (defence at the sink); refusing control
// characters here too gives the model a repair message instead of a silently mangled
// comment. Ordinary punctuation, quotes and backticks are NOT refused - they are escaped.
function textIssues(where: string, value: unknown, max: number): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") return [`${where} must be a string`];
  const out: string[] = [];
  if (value.length > max) out.push(`${where} is too long (${value.length} > ${max} characters)`);
  if (hasUnsafeChars(value)) {
    out.push(
      `${where} contains a control or line-break character - write it as one plain line of text`
    );
  }
  return out;
}

export function validateChangeSpec(spec: ChangeSpec, appModel: AppModel): string[] {
  const issues: string[] = [];
  const flowIds = new Set(appModel.flows.map((f) => f.id));
  const stepsByFlow = new Map(appModel.flows.map((f) => [f.id, new Set(f.steps.map((s) => s.id))]));

  if (spec.capabilities.length === 0) issues.push("the plan has no capabilities — it is empty");
  issues.push(...textIssues("plan name", spec.name, MAX_LABEL_LENGTH));
  issues.push(...textIssues("compute target", spec.compute?.target, MAX_LABEL_LENGTH));

  for (const cap of spec.capabilities) {
    if (!KEBAB.test(cap.id)) issues.push(`capability id "${cap.id}" must be kebab-case`);
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
    const exists = flowIds.has(cap.id);
    if (cap.op === "create" && exists) {
      issues.push(`flow "${cap.id}" already exists — use op "extend", not "create"`);
    }
    if ((cap.op === "extend" || cap.op === "modify" || cap.op === "delete") && !exists) {
      issues.push(`op "${cap.op}" targets flow "${cap.id}", but no such flow exists`);
    }
    const known = stepsByFlow.get(cap.id);
    for (const step of cap.steps) {
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
