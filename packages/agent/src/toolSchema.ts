import type { ZodTypeAny } from "zod";

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
 * transforms (`ZodEffects` is described by its inner schema), `ZodLazy` past
 * depth {@link MAX_DEPTH}, `ZodMap`/`ZodSet`/`ZodFunction`/`ZodPromise`, and
 * regex flags. A description that is looser than the validator is safe — the
 * validator still refuses; a description tighter than the validator is not, and
 * none of these mappings is.
 */

const MAX_DEPTH = 16;
const MAX_ISSUES = 5;
const MAX_ISSUE_CHARS = 200;

type Json = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: reading Zod 3 internals (`_def`) that have no public type
type Def = any;

function describe(schema: ZodTypeAny, out: Json): Json {
  const d = (schema as { description?: string }).description;
  return d !== undefined ? { ...out, description: d } : out;
}

function convert(schema: ZodTypeAny, depth: number): Json {
  if (depth > MAX_DEPTH) return {};
  const def = (schema as { _def: Def })._def;
  const next = (s: ZodTypeAny): Json => convert(s, depth + 1);
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
        else if (c.kind === "regex") out.pattern = (c.regex as RegExp).source;
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
      return describe(schema, { type: "string", format: "date-time" });
    case "ZodLiteral":
      return describe(schema, { const: def.value });
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
        if (!v.isOptional()) required.push(k);
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
      return withDescription(schema, {
        ...next(def.innerType),
        default: def.defaultValue(),
      });
    case "ZodEffects":
      return withDescription(schema, next(def.schema));
    case "ZodPipeline":
      return withDescription(schema, next(def.in));
    case "ZodLazy":
      return next(def.getter());
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
export function toolInputJsonSchema(schema: ZodTypeAny | undefined): Record<string, unknown> {
  if (schema === undefined) return { type: "object" };
  return convert(schema, 0);
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
  const r = schema.safeParse(input);
  if (r.success) return { ok: true };
  const all = r.error.issues;
  return {
    ok: false,
    truncated: all.length > MAX_ISSUES,
    issues: all.slice(0, MAX_ISSUES).map((i) => ({
      path: i.path.join("."),
      message: i.message.slice(0, MAX_ISSUE_CHARS),
    })),
  };
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
  allowed: ReadonlySet<string>;
  schemaOf: (id: string) => Record<string, unknown>;
  check: (name: string, input: unknown) => { error: Record<string, unknown> } | undefined;
} {
  const byId = new Map(tools.map((t) => [t.id, t]));
  return {
    allowed: new Set(byId.keys()),
    schemaOf: (id) => toolInputJsonSchema(byId.get(id)?.inputSchema),
    check(name, input) {
      const tool = byId.get(name);
      if (tool === undefined) {
        return {
          error: {
            code: "tool_not_on_menu",
            message: `Tool "${name}" is not available. Call one of: ${[...byId.keys()].join(", ")}.`,
          },
        };
      }
      const v = validateToolInput(tool.inputSchema, input);
      if (v.ok) return undefined;
      return {
        error: {
          code: "invalid_tool_input",
          message: `Input for tool "${name}" does not match its schema; it was not run.`,
          issues: v.issues,
          ...(v.truncated && { truncated: true }),
        },
      };
    },
  };
}
