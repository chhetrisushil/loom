/**
 * R4b — the MINIMAL structural check for an MCP tool call, run INSIDE the tool's
 * effect so its verdict is part of the journaled step output.
 *
 * Why inside the effect and not in the agent loop before `ctx.execute`: the
 * schema comes from a LIVE `tools/list` at boot. A gate outside the journaled
 * step reads that schema again on replay, so after server schema drift a call
 * the log records as executed would be refused on replay and the recorded
 * output never served. Inside the effect the verdict (refusal or result) IS the
 * recorded output; replay never re-evaluates it.
 *
 * It is NOT a JSON Schema validator (no nesting, `enum`, bounds, combinators):
 * the server stays the authority. Looser than the server by construction.
 */
const MAX_ECHO = 64;
const MAX_ISSUES = 5;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function typeOk(v: unknown, t: string): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return isObj(v);
    default:
      return true;
  }
}

/** `undefined` = the input is shaped as the schema says; else the refusal result. */
export function refuseMalformedInput(schema: unknown, input: unknown): unknown {
  const issues: { path: string; message: string }[] = [];
  if (!isObj(input)) {
    issues.push({ path: "", message: "expected an object" });
  } else if (isObj(schema)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const k of required) {
      if (typeof k !== "string") continue;
      if (!Object.hasOwn(input, k) || input[k] === undefined)
        issues.push({ path: k.slice(0, MAX_ECHO), message: "required" });
    }
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const [k, sub] of Object.entries(props)) {
      if (!Object.hasOwn(input, k) || input[k] === undefined || !isObj(sub)) continue;
      const t = sub.type;
      const types =
        typeof t === "string"
          ? [t]
          : Array.isArray(t)
            ? t.filter((x): x is string => typeof x === "string")
            : undefined;
      if (types !== undefined && types.length > 0 && !types.some((x) => typeOk(input[k], x)))
        issues.push({
          path: k.slice(0, MAX_ECHO),
          message: `expected ${types.join(" | ").slice(0, MAX_ECHO)}`,
        });
    }
  }
  if (issues.length === 0) return undefined;
  return {
    error: {
      code: "invalid_tool_input",
      message: "The tool input does not match the tool's input schema.",
      issues: issues.slice(0, MAX_ISSUES),
      ...(issues.length > MAX_ISSUES && { truncated: true }),
    },
  };
}
