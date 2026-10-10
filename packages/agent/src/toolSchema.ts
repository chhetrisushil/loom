import { isTainted } from "@loom/classify";
import type { ZodTypeAny } from "zod";
import { sanitizeJsonSchema } from "./thirdPartySchema";

/**
 * A minimal Zod 3 → JSON Schema converter, enough to tell a model the argument
 * STRUCTURE of a tool (property names, types, required, enums, bounds).
 *
 * Why in `@loom/agent` and not `@loom/llm`: `@loom/agent` already depends on `zod`
 * and is the only place that turns a `ToolDefinition` into a model-facing spec;
 * `@loom/llm` is the provider SPI and carries no Zod dependency. Why hand-written
 * rather than `zod-to-json-schema`: that package is not in the workspace
 * lockfile, and a new third-party runtime dependency on the agent path is a
 * bigger decision than ~100 lines that only DESCRIBE (the schema is advisory to
 * the model; enforcement is `safeParse` in {@link validateToolInput}).
 *
 * LIMITS (by design, all degrade to the permissive `{}`): refinements and
 * transforms (`ZodEffects` is described by its inner schema), `ZodLazy` (a lazy
 * already being expanded, or past depth {@link MAX_DEPTH}), `ZodMap`/`ZodSet`/
 * `ZodFunction`/`ZodPromise`, a regex WITH flags (no `pattern` is emitted, since
 * a bare `pattern` would be case-sensitive etc.), a non-coercing `z.date()`
 * (it rejects every JSON string, so no string is described), non-JSON literals
 * (`bigint`), and `default` values (never evaluated: a thunk may be impure).
 * `ZodCatch`/`ZodEffects`/preprocess are described by their inner schema, which
 * accepts MORE than the outer schema can — the harmless direction. A description
 * looser than the validator is safe — the validator still refuses; one tighter
 * is not, and none of these mappings is. A converter fault in any node degrades
 * that node to `{}`; it never throws. A non-object ROOT (`z.string()`) is
 * described as a bare `{ type: "object" }`: providers require an object root,
 * so non-object tool inputs are not described (they are still validated).
 */

const MAX_DEPTH = 16;
const MAX_ISSUES = 5;
const MAX_ISSUE_CHARS = 200;
const MAX_ECHO_CHARS = 200;
/** Input pre-check bounds: deeper / larger than this is refused before Zod recurses. */
const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 100_000;

export const cap = (s: string, n = MAX_ECHO_CHARS): string =>
  s.length > n ? `${s.slice(0, n)}…` : s;

type Json = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: reading Zod 3 internals (`_def`) that have no public type
type Def = any;

function describe(schema: ZodTypeAny, out: Json): Json {
  const d = (schema as { description?: string }).description;
  return d !== undefined ? { ...out, description: d } : out;
}

interface ConvState {
  /** Lazy schemas currently being expanded: re-entry returns `{}` (bounds recursive schemas). */
  lazies: Set<unknown>;
}

function convert(schema: ZodTypeAny, depth: number, st: ConvState): Json {
  try {
    return convertNode(schema, depth, st);
  } catch {
    return {}; // a converter fault degrades this node, never the run
  }
}

function isOptionalSafe(v: ZodTypeAny): boolean {
  try {
    // Structural first: `isOptional()` is `safeParse(undefined)`, which would run a
    // `.default()` thunk and any refinement on `undefined`.
    const d = (v as { _def: Def })._def;
    if (d?.typeName === "ZodOptional" || d?.typeName === "ZodDefault") return true;
    if (d?.typeName === "ZodEffects") return isOptionalSafe(d.schema);
    return v.isOptional();
  } catch {
    return true; // looser is safe
  }
}

function convertNode(schema: ZodTypeAny, depth: number, st: ConvState): Json {
  if (depth > MAX_DEPTH) return {};
  const def = (schema as { _def: Def })._def;
  const next = (s: ZodTypeAny): Json => convert(s, depth + 1, st);
  switch (def?.typeName) {
    case "ZodString": {
      const out: Json = { type: "string" };
      for (const c of def.checks ?? []) {
        if (c.kind === "min") out.minLength = c.value;
        else if (c.kind === "max") out.maxLength = c.value;
        else if (c.kind === "length") {
          out.minLength = c.value;
          out.maxLength = c.value;
        } else if (c.kind === "email") out.format = "email";
        else if (c.kind === "url") out.format = "uri";
        else if (c.kind === "uuid") out.format = "uuid";
        else if (c.kind === "datetime") out.format = "date-time";
        else if (c.kind === "regex" && (c.regex as RegExp).flags === "")
          out.pattern = (c.regex as RegExp).source;
      }
      return describe(schema, out);
    }
    case "ZodNumber": {
      const out: Json = { type: "number" };
      for (const c of def.checks ?? []) {
        if (c.kind === "int") out.type = "integer";
        else if (c.kind === "min") out[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
        else if (c.kind === "max") out[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
      }
      return describe(schema, out);
    }
    case "ZodBigInt":
      return describe(schema, { type: "integer" });
    case "ZodBoolean":
      return describe(schema, { type: "boolean" });
    case "ZodNull":
      return describe(schema, { type: "null" });
    case "ZodDate":
      // Only `z.coerce.date()` accepts the JSON string a model can send.
      return def.coerce === true
        ? describe(schema, { type: "string", format: "date-time" })
        : describe(schema, {});
    case "ZodLiteral": {
      const t = typeof def.value;
      if (def.value !== null && t !== "string" && t !== "number" && t !== "boolean") return {};
      return describe(schema, { const: def.value });
    }
    case "ZodEnum":
      return describe(schema, { type: "string", enum: [...def.values] });
    case "ZodNativeEnum": {
      // numeric enums carry a reverse mapping (value -> name); keep the forward half
      const vals = Object.entries(def.values as Record<string, unknown>)
        .filter(([k]) => Number.isNaN(Number(k)))
        .map(([, v]) => v);
      return describe(schema, { enum: vals });
    }
    case "ZodArray": {
      const out: Json = { type: "array", items: next(def.type) };
      if (def.minLength) out.minItems = def.minLength.value;
      if (def.maxLength) out.maxItems = def.maxLength.value;
      return describe(schema, out);
    }
    case "ZodTuple":
      return describe(schema, {
        type: "array",
        prefixItems: (def.items as ZodTypeAny[]).map(next),
        minItems: def.items.length,
        ...(def.rest == null && { maxItems: def.items.length }),
      });
    case "ZodObject": {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      const properties: Json = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = next(v);
        if (!isOptionalSafe(v)) required.push(k);
      }
      const out: Json = { type: "object", properties };
      if (required.length > 0) out.required = required;
      if (def.unknownKeys === "strict") out.additionalProperties = false;
      return describe(schema, out);
    }
    case "ZodRecord":
      return describe(schema, { type: "object", additionalProperties: next(def.valueType) });
    case "ZodUnion":
      return describe(schema, { anyOf: (def.options as ZodTypeAny[]).map(next) });
    case "ZodDiscriminatedUnion":
      return describe(schema, {
        anyOf: [...(def.options as Iterable<ZodTypeAny>)].map(next),
      });
    case "ZodIntersection":
      return describe(schema, { allOf: [next(def.left), next(def.right)] });
    case "ZodOptional":
    case "ZodReadonly":
    case "ZodBranded":
    case "ZodCatch":
      return withDescription(schema, next(def.innerType ?? def.type));
    case "ZodNullable":
      return describe(schema, { anyOf: [next(def.innerType), { type: "null" }] });
    case "ZodDefault":
      // The default is deliberately NOT described: `defaultValue()` is a thunk
      // (impure, or a non-JSON value like a bigint) and the field is optional anyway.
      return withDescription(schema, next(def.innerType));
    case "ZodEffects":
      return withDescription(schema, next(def.schema));
    case "ZodPipeline":
      return withDescription(schema, next(def.in));
    case "ZodLazy": {
      if (st.lazies.has(schema)) return {};
      st.lazies.add(schema);
      try {
        return next(def.getter());
      } finally {
        st.lazies.delete(schema);
      }
    }
    default:
      // ZodAny / ZodUnknown / anything not modelled: permissive on purpose.
      return {};
  }
}

function withDescription(schema: ZodTypeAny, inner: Json): Json {
  const d = (schema as { description?: string }).description;
  return d !== undefined && inner.description === undefined ? { ...inner, description: d } : inner;
}

/**
 * JSON Schema (draft 2020-12 vocabulary) for a tool's Zod input schema. A tool
 * with no schema (possible from untyped JS) is described as a bare object.
 */
export function toolInputJsonSchema(
  schema: ZodTypeAny | undefined,
  jsonInputSchema?: Readonly<Record<string, unknown>>,
  opts: { trustText?: boolean; keepZodText?: boolean; toolId?: string } = {}
): Record<string, unknown> {
  // R4b — a declared JSON Schema (MCP) wins over the Zod schema, which for such
  // a tool is a placeholder `z.unknown()`. Third-party bytes: bounded, sanitised,
  // free text stripped unless trusted. Refused => bare object, never a failed run.
  if (jsonInputSchema !== undefined) {
    const clean = sanitizeJsonSchema(jsonInputSchema, { keepText: opts.trustText === true });
    if (clean !== undefined) return clean;
    warnThirdPartySchema(opts.toolId);
    return { type: "object" };
  }
  if (schema === undefined) return { type: "object" };
  let j = convert(schema, 0, { lazies: new Set() });
  // A REMOTE tool with a Zod schema (an A2A peer, a plugin marking `origin: "remote"`) carries its
  // `.describe()` prose to the model the same way a JSON Schema's would: strip it unless vouched
  // (`trustText` explicitly false; first-party callers leave it unset and keep their text).
  if (opts.trustText === false && opts.keepZodText !== true)
    j = sanitizeJsonSchema(j, { keepText: false }) ?? { type: "object" };
  // Providers require an object root. A non-object root is not describable.
  if (j.type !== undefined && j.type !== "object") return { type: "object" };
  if ("const" in j || "enum" in j) return { type: "object" };
  // An unconstrained root (`z.any()`, `z.unknown()`, a degraded node) still needs an object root.
  if (j.type === undefined && !("anyOf" in j) && !("allOf" in j) && !("oneOf" in j))
    return { ...j, type: "object" };
  return j;
}

const MAX_WARNED = 1000;
const warnedSchemas = new Set<string>();
const warnedTrust = new Set<string>();
const emit = (m: string, code: string): void => {
  const proc = (globalThis as { process?: { emitWarning?: (m: string, o?: object) => void } })
    .process;
  proc?.emitWarning?.(m, { code });
};
/** Once per tool id (bounded set), so a second bad tool is not hidden by the first. */
function warnOnce(seen: Set<string>, id: string, message: string, code: string): void {
  if (seen.has(id) || seen.size >= MAX_WARNED) return;
  seen.add(id);
  emit(message, code);
}
function warnThirdPartySchema(id = "(unnamed tool)"): void {
  warnOnce(
    warnedSchemas,
    id,
    `The JSON input schema of tool "${id.slice(0, 64)}" was refused (cyclic, too deep/large, over the attacker-text budget, or not an object schema); the model is shown a bare \`{ type: "object" }\` for it. The tool still runs.`,
    "LOOM_AGENT_TOOL_SCHEMA"
  );
}

/** Test seam: re-arm the one-time advisories. */
export function resetToolSchemaWarning(): void {
  warnedSchemas.clear();
  warnedTrust.clear();
}

/** What the model is told about a third-party tool whose description is withheld. */
export const WITHHELD_DESCRIPTION = "Third-party tool; description withheld";
const MAX_DESCRIPTION = 1000;

/**
 * Built from a REMOTE declaration (ADR 0125 D7 / D14): the plugin marked it (`origin: "remote"`), or it
 * carries a remote JSON Schema (MCP), or it is an A2A peer. Fails closed: ANY of the three suffices,
 * so a plugin that forgets the marker is still treated as remote.
 */
export const isRemoteTool = (t: {
  origin?: string;
  jsonInputSchema?: unknown;
  kind?: string;
}): boolean => t.origin === "remote" || t.jsonInputSchema !== undefined || t.kind === "a2a";

/**
 * What the model may be told about a tool: its description and JSON Schema. A REMOTE tool (see
 * {@link isRemoteTool}: MCP, A2A, or marked `origin: "remote"`) is third-party (ADR 0085): unless it
 * states `trustJsonSchemaText`, its description is replaced by a fixed neutral string and the schema's
 * text is stripped: a JSON Schema's prose AND a Zod schema's `.describe()` text (review round 1). A trusted description is still capped, and a TAINTED description is never put in
 * the spec of a remote tool, vouched or not (ADR 0125 D14). A tainted description on a first-party tool
 * is passed through untouched so the prompt boundary refuses the request loudly.
 */
export function toolSpecFor(t: {
  id: string;
  description: string;
  inputSchema?: ZodTypeAny;
  jsonInputSchema?: Readonly<Record<string, unknown>>;
  trustJsonSchemaText?: boolean;
  origin?: string;
  kind?: string;
  schemaOrigin?: string;
}): { name: string; description: string; inputSchema: Record<string, unknown> } {
  const thirdParty = isRemoteTool(t);
  const trusted = !thirdParty || t.trustJsonSchemaText === true;
  if (thirdParty && trusted)
    warnOnce(
      warnedTrust,
      t.id,
      `Tool "${t.id.slice(0, 64)}" is a remote (third-party) tool whose description and schema text is trusted (trustJsonSchemaText / trustDescriptions): it reaches the model as instructions, unguarded.`,
      "LOOM_AGENT_TRUSTED_TOOL_TEXT"
    );
  return {
    name: t.id,
    description: !thirdParty
      ? t.description
      : trusted && !isTainted(t.description)
        ? t.description.slice(0, MAX_DESCRIPTION)
        : WITHHELD_DESCRIPTION,
    inputSchema: toolInputJsonSchema(t.inputSchema, t.jsonInputSchema, {
      trustText: trusted,
      // A Zod schema loom or the host AUTHORED (an A2A peer's static schema) keeps its `.describe()` text
      // even on a remote tool; only the opt-in `schemaOrigin: "local"` does, and never beside a
      // `jsonInputSchema` (remote bytes, handled before this flag is read). Fail closed otherwise.
      keepZodText: t.schemaOrigin === "local",
      toolId: t.id,
    }),
  };
}

export interface ToolInputIssue {
  path: string;
  message: string;
}

export type ToolInputCheck =
  | { ok: true }
  | { ok: false; issues: ToolInputIssue[]; truncated: boolean };

/**
 * Validate a model-supplied tool input against the tool's schema BEFORE it is
 * executed. Issues are bounded (count and per-message length) so a hostile
 * input cannot bloat the model transcript. A tool without a schema is allowed
 * as-is: `ToolDefinition.inputSchema` is required by type, so absence only
 * arises from untyped callers, and the effect itself remains the validator.
 */
export function validateToolInput(schema: ZodTypeAny | undefined, input: unknown): ToolInputCheck {
  if (schema === undefined) return { ok: true };
  let bounded: boolean;
  try {
    bounded = withinInputBounds(input);
  } catch {
    // A throwing getter/proxy in the input: same fixed refusal as a schema fault.
    bounded = false;
  }
  if (!bounded) {
    return {
      ok: false,
      truncated: false,
      issues: [{ path: "", message: "input exceeds the depth or size limit" }],
    };
  }
  let r: ReturnType<ZodTypeAny["safeParse"]>;
  try {
    r = schema.safeParse(input);
  } catch {
    // Async / throwing refinements, recursion: a schema fault is a refusal, with
    // a FIXED message (a thrown message could echo anything), never a throw.
    return {
      ok: false,
      truncated: false,
      issues: [{ path: "", message: "schema check failed" }],
    };
  }
  if (r.success) return { ok: true };
  const all = r.error.issues;
  return {
    ok: false,
    truncated: all.length > MAX_ISSUES,
    issues: all.slice(0, MAX_ISSUES).map((i) => ({
      path: cap(i.path.join(".")),
      message: i.message.slice(0, MAX_ISSUE_CHARS),
    })),
  };
}

/** Iterative (no recursion) depth/node bound so Zod is never driven deeper than {@link MAX_INPUT_DEPTH}. */
function withinInputBounds(input: unknown): boolean {
  const stack: Array<[unknown, number]> = [[input, 0]];
  let nodes = 0;
  while (stack.length > 0) {
    const [v, d] = stack.pop() as [unknown, number];
    if (v === null || typeof v !== "object") continue;
    if (d > MAX_INPUT_DEPTH || ++nodes > MAX_INPUT_NODES) return false;
    for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push([c, d + 1]);
  }
  return true;
}

/**
 * The tool menu: model-facing specs plus the gate that decides whether a call
 * the model returned may run. Built once per run from the definitions the model
 * was shown, so what the model could see and what may execute cannot diverge.
 *
 * A refusal is a pure function of the (recorded) model output and the static
 * menu: no clock, no I/O, nothing appended — replay recomputes it identically.
 * It is returned as a structured RESULT (not thrown): the model can recover by
 * choosing a listed tool or fixing its arguments, and an off-menu name is
 * information about the model, not a fault in the run.
 */
export function buildToolMenu(tools: ReadonlyArray<{ id: string; inputSchema?: ZodTypeAny }>): {
  has: (name: string) => boolean;
  check: (name: string, input: unknown) => { error: Record<string, unknown> } | undefined;
} {
  const byId = new Map(tools.map((t) => [t.id, t]));
  return {
    has: (name) => byId.has(name),
    check(name, input) {
      const tool = byId.get(name);
      if (tool === undefined) {
        return {
          error: {
            code: "tool_not_on_menu",
            message: `Tool "${cap(name)}" is not available. Call one of: ${[...byId.keys()].join(", ")}.`,
          },
        };
      }
      const v = validateToolInput(tool.inputSchema, input);
      if (v.ok) return undefined;
      return {
        error: {
          code: "invalid_tool_input",
          message: `Input for tool "${cap(name)}" does not match its schema; it was not run.`,
          issues: v.issues,
          ...(v.truncated && { truncated: true }),
        },
      };
    },
  };
}
