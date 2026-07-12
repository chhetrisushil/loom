import type { CapabilityChange, ChangeSpec, Op, StepChange } from "@loom/appgen";

// Semantic validation of the model's output. Grammar-constrained decoding already
// guarantees well-formed, on-schema JSON; this layer turns that JSON into a typed
// ChangeSpec and rejects anything structurally unusable (so the reasoning ladder can
// elevate, and the caller can fall back to the deterministic parser). Pure, no I/O.

const OPS = new Set<Op>(["create", "extend", "modify"]);

/** Extract the first balanced JSON object from model text (tolerating ``` fences/prose). */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function asOp(v: unknown): Op | undefined {
  return typeof v === "string" && OPS.has(v as Op) ? (v as Op) : undefined;
}

function coerceStep(raw: unknown): StepChange | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const op = asOp(r.op) ?? "create";
  return typeof r.id === "string" && r.id.length > 0 ? { id: r.id, op } : undefined;
}

function coerceCapability(raw: unknown): CapabilityChange | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return undefined;
  const op = asOp(r.op) ?? "create";
  const steps = Array.isArray(r.steps)
    ? r.steps.map(coerceStep).filter((s): s is StepChange => s !== undefined)
    : [];
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : r.id,
    intent: typeof r.intent === "string" ? r.intent : "",
    op,
    steps,
    ...(r.addApproval === true && { addApproval: true }),
    ...(r.addUi === true && { addUi: true }),
  };
}

/**
 * Parse model output into a ChangeSpec, or `undefined` if it isn't structurally usable
 * (no valid capabilities). Used both as the post-hoc parser and as the reasoning
 * ladder's confidence validator. `planner` is stamped `"model"`.
 */
export function tryParseChangeSpec(content: string): ChangeSpec | undefined {
  const json = extractJsonObject(content);
  if (json === undefined) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  const r = obj as Record<string, unknown>;

  const capabilities = Array.isArray(r.capabilities)
    ? r.capabilities.map(coerceCapability).filter((c): c is CapabilityChange => c !== undefined)
    : [];
  if (capabilities.length === 0) return undefined;

  const name = typeof r.name === "string" && r.name.length > 0 ? r.name : capabilities[0]!.id;
  const compute =
    typeof r.compute === "object" &&
    r.compute !== null &&
    typeof (r.compute as Record<string, unknown>).target === "string"
      ? { target: (r.compute as Record<string, unknown>).target as string }
      : undefined;

  return {
    name,
    capabilities,
    ...(compute !== undefined && { compute }),
    planner: "model",
  };
}
