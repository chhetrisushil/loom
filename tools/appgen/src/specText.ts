import { EXISTING_ID, NEW_ID, NEW_ID_HINT, hasUnsafeChars } from "./emit";

// One definition of "what a plan field may contain", shared by the model validator
// (`validateChangeSpec` in @loom/appgen-model) and by `readLockfile`, so a `--from-spec`
// replay is held to exactly the rules a freshly planned spec is. (A replayed spec never
// goes through the validator; the lockfile is hand-editable, shareable data.)

/** Longest free-text field a plan may carry (an intent is a sentence, not a document). */
export const MAX_INTENT_LENGTH = 500;
/** Longest name / label / model id / tool id. */
export const MAX_LABEL_LENGTH = 200;
/** Most grants one capability may carry. */
export const MAX_GRANTS = 64;

const OPS = new Set(["create", "extend", "modify", "delete"]);

/**
 * Issues with one optional free-text field: not a string, too long, or carrying a control /
 * line-break / bidi / zero-width / tag character. Ordinary punctuation, quotes, backticks
 * and `${` are NOT refused - the sinks escape them.
 */
export function textIssues(where: string, value: unknown, max: number): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") return [`${where} must be a string`];
  const out: string[] = [];
  if (value.length > max) out.push(`${where} is too long (${value.length} > ${max} characters)`);
  if (hasUnsafeChars(value)) {
    out.push(
      `${where} contains a control, line-break or invisible/bidi character - write it as one plain line of text`
    );
  }
  return out;
}

/** Issues with an OPTIONAL list of short strings (tool ids, model names). */
export function textListIssues(
  where: string,
  value: unknown,
  max: number,
  limit: number
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`${where} must be an array of strings`];
  const out: string[] = [];
  if (value.length > limit) out.push(`${where} has too many entries (${value.length} > ${limit})`);
  for (const [i, v] of value.slice(0, limit).entries()) {
    if (typeof v !== "string") out.push(`${where}[${i}] must be a string`);
    else if (v.length === 0) out.push(`${where}[${i}] must not be empty`);
    else out.push(...textIssues(`${where}[${i}]`, v, max));
  }
  return out;
}

/**
 * Every structural and character issue in a ChangeSpec that arrives as untyped data (a
 * lockfile): field types, ops, id shapes (strict for a `create`, loose for an existing id)
 * and the free-text rules above, over EVERY field that reaches a codegen sink - plan name,
 * compute target, per-capability name / intent / reasoning models / grants, and the
 * reasoning-ladder elevations.
 */
export function changeSpecDataIssues(spec: unknown): string[] {
  if (typeof spec !== "object" || spec === null) return ["changeSpec must be an object"];
  const s = spec as Record<string, unknown>;
  const out: string[] = [];
  if (typeof s.name !== "string") out.push("plan name must be a string");
  else out.push(...textIssues("plan name", s.name, MAX_LABEL_LENGTH));
  if (s.planner !== "deterministic" && s.planner !== "model") {
    out.push('planner must be "deterministic" or "model"');
  }
  if (s.compute !== undefined) {
    if (typeof s.compute !== "object" || s.compute === null) out.push("compute must be an object");
    else
      out.push(
        ...textIssues(
          "compute target",
          (s.compute as Record<string, unknown>).target,
          MAX_LABEL_LENGTH
        )
      );
  }
  if (s.elevations !== undefined) {
    if (!Array.isArray(s.elevations)) out.push("elevations must be an array");
    else {
      for (const [i, e] of s.elevations.entries()) {
        const r = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
        for (const k of ["from", "to", "reason"]) {
          if (typeof r[k] !== "string") out.push(`elevations[${i}].${k} must be a string`);
          else out.push(...textIssues(`elevations[${i}].${k}`, r[k], MAX_INTENT_LENGTH));
        }
      }
    }
  }
  if (!Array.isArray(s.capabilities)) return [...out, "capabilities must be an array"];
  for (const [i, c] of s.capabilities.entries()) {
    if (typeof c !== "object" || c === null) {
      out.push(`capabilities[${i}] must be an object`);
      continue;
    }
    const cap = c as Record<string, unknown>;
    const at = typeof cap.id === "string" ? `"${cap.id}"` : `capabilities[${i}]`;
    const isCreate = cap.op === "create";
    out.push(...idIssues("capability", cap.id, isCreate));
    if (typeof cap.op !== "string" || !OPS.has(cap.op)) out.push(`op of ${at} is not a known op`);
    if (typeof cap.name !== "string") out.push(`name of ${at} must be a string`);
    out.push(...textIssues(`name of ${at}`, cap.name, MAX_LABEL_LENGTH));
    if (typeof cap.intent !== "string") out.push(`intent of ${at} must be a string`);
    out.push(...textIssues(`intent of ${at}`, cap.intent, MAX_INTENT_LENGTH));
    for (const k of ["addApproval", "addUi"]) {
      if (cap[k] !== undefined && typeof cap[k] !== "boolean")
        out.push(`${k} of ${at} must be a boolean`);
    }
    out.push(
      ...textListIssues(`wireGrants of ${at}`, cap.wireGrants, MAX_LABEL_LENGTH, MAX_GRANTS)
    );
    if (cap.reasoning !== undefined) {
      if (typeof cap.reasoning !== "object" || cap.reasoning === null) {
        out.push(`reasoning of ${at} must be an object`);
      } else {
        const r = cap.reasoning as Record<string, unknown>;
        out.push(...textIssues(`reasoning base model of ${at}`, r.baseModel, MAX_LABEL_LENGTH));
        out.push(
          ...textListIssues(
            `reasoning elevation models of ${at}`,
            r.elevateTo,
            MAX_LABEL_LENGTH,
            MAX_GRANTS
          )
        );
      }
    }
    if (!Array.isArray(cap.steps)) {
      out.push(`steps of ${at} must be an array`);
      continue;
    }
    for (const st of cap.steps) {
      const step = (typeof st === "object" && st !== null ? st : {}) as Record<string, unknown>;
      out.push(...idIssues("step", step.id, isCreate || step.op === "create"));
      if (typeof step.op !== "string" || !OPS.has(step.op))
        out.push(`a step op in ${at} is not a known op`);
    }
  }
  return out;
}

function idIssues(kind: string, id: unknown, isNew: boolean): string[] {
  if (typeof id !== "string") return [`${kind} id ${JSON.stringify(id)} must be a string`];
  if (isNew && !NEW_ID.test(id)) {
    return [`${kind} id ${JSON.stringify(id)} must be kebab-case: ${NEW_ID_HINT}`];
  }
  if (!isNew && !EXISTING_ID.test(id))
    return [`${kind} id ${JSON.stringify(id)} must be kebab-case`];
  return [];
}
