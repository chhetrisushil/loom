import { type AppModel, type ChangeSpec, hasUnsafeChars, stepConstName } from "@loom/appgen";

// Semantic validation of a model-produced ChangeSpec against the scanned app. The
// grammar already guarantees the JSON is well-formed and on-schema; this catches the
// mistakes a model still makes — referencing a flow/step that doesn't exist, using
// `create` for something that's already there, malformed ids. The issue list drives the
// self-repair loop (re-prompt the model with what was wrong).

// Loose shape: what an EXISTING flow/step id may look like (apps predate the strict rule).
const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
// Strict shape for every NEW id (a `create`d step or flow). Both become generated
// identifiers (`<camel>Step`, `<Pascal>Flow`), so the id must start with a letter
// (`1-run` -> `1RunStep` is not an identifier) and have no trailing/double dash (`a-` and
// `a--b` collapse onto `a` and `a-b`).
const STRICT_KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const STRICT_HINT = "start with a letter, no leading digit, no trailing or double dash";

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

  // Step ids are unique PER FLOW (a step id is the key inside one flow's execution; the
  // runtime does not require them to be unique across flows). Tracked across every
  // operation on the same flow so two ops cannot both touch one id.
  const seenByFlow = new Map<string, Set<string>>();
  // Generated const name -> the step id that claimed it, per flow. Pre-seeded with the
  // scanned flow's steps so a new `a--b` cannot shadow an existing `a-b`.
  const namesByFlow = new Map<string, Map<string, string>>();
  const createdFlows = new Set<string>();

  if (spec.capabilities.length === 0) issues.push("the plan has no capabilities — it is empty");
  issues.push(...textIssues("plan name", spec.name, MAX_LABEL_LENGTH));
  issues.push(...textIssues("compute target", spec.compute?.target, MAX_LABEL_LENGTH));

  for (const cap of spec.capabilities) {
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
    const isNew = cap.op === "create" && !exists;
    if (isNew) {
      if (!STRICT_KEBAB.test(cap.id))
        issues.push(`capability id "${cap.id}" must be kebab-case: ${STRICT_HINT}`);
      if (createdFlows.has(cap.id))
        issues.push(
          `flow "${cap.id}" is created more than once — declare each new flow once, with all its steps`
        );
      createdFlows.add(cap.id);
    } else if (!KEBAB.test(cap.id)) {
      issues.push(`capability id "${cap.id}" must be kebab-case`);
    }
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
    let names = namesByFlow.get(cap.id);
    if (names === undefined) {
      names = new Map();
      for (const id of known ?? []) names.set(stepConstName(id), id);
      namesByFlow.set(cap.id, names);
    }
    for (const step of cap.steps) {
      if (seen.has(step.id)) {
        issues.push(
          `flow "${cap.id}" declares step id "${step.id}" more than once — step ids must be unique within a flow; use each id once`
        );
        continue;
      }
      seen.add(step.id);
      if (isNew && (step.op === "modify" || step.op === "delete")) {
        issues.push(
          `step "${step.id}" op "${step.op}" but flow "${cap.id}" is being created — there is nothing to ${step.op}`
        );
        continue;
      }
      if (step.op === "create") {
        if (!STRICT_KEBAB.test(step.id)) {
          issues.push(`step id "${step.id}" in "${cap.id}" must be kebab-case: ${STRICT_HINT}`);
          continue;
        }
        const name = stepConstName(step.id);
        const owner = names.get(name);
        if (owner !== undefined && owner !== step.id) {
          issues.push(
            `step ids "${owner}" and "${step.id}" in flow "${cap.id}" both generate the name "${name}" — rename one`
          );
          continue;
        }
        names.set(name, step.id);
      } else if (!KEBAB.test(step.id)) {
        issues.push(`step id "${step.id}" in "${cap.id}" must be kebab-case`);
      }
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
