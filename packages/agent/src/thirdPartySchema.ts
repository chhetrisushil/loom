/**
 * R4b — a THIRD PARTY's JSON Schema (an MCP server's `inputSchema`) is bytes we
 * did not write that are about to be placed in a model prompt. This module
 * turns it into something safe to send, and into a small structural check.
 *
 * Sanitisation is an ALLOWLIST of JSON Schema keywords (everything else —
 * `x-*` extensions, `default`, `examples`, `$comment`, `$id`, `$schema`, … — is
 * dropped), under hard bounds: depth {@link MAX_DEPTH}, {@link MAX_NODES}
 * schema nodes, strings capped at {@link MAX_STR}. A cyclic structure, or one
 * past any bound, is REFUSED as a whole (`undefined`); the caller falls back to
 * `{ type: "object" }` and warns. It never throws. A `$ref` survives only if it
 * is a same-document pointer (`#`, `#/…`): nothing is ever fetched, and a
 * remote ref is dropped (the node becomes permissive).
 *
 * Free text (`description`, `title`) is stripped unless the caller states trust
 * (`keepText`): it is read as instructions by every provider (ADR 0085). What
 * remains textual and is NOT removable without destroying the schema — property
 * names and `enum`/`const` strings — is capped at {@link MAX_STR} chars; a
 * hostile server can still say something short there, which is why the
 * description is the default-deny surface and not a complete defence.
 */
import type { ToolInputCheck, ToolInputIssue } from "./toolSchema";

const MAX_DEPTH = 16;
const MAX_NODES = 1000;
const MAX_STR = 200;
const MAX_TEXT = 1000;
const MAX_LIST = 100;
const MAX_SIZE = 64 * 1024;

type Json = Record<string, unknown>;

const TYPES = new Set(["string", "number", "integer", "boolean", "null", "array", "object"]);
const NUM_KEYS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
] as const;
const SCHEMA_KEYS = ["items", "additionalProperties", "not", "contains"] as const;
const SCHEMA_LIST_KEYS = ["prefixItems", "anyOf", "oneOf", "allOf"] as const;
const SCHEMA_MAP_KEYS = ["properties", "$defs", "definitions"] as const;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrim = (v: unknown): v is string | number | boolean | null =>
  v === null ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v)) ||
  (typeof v === "string" && v.length <= MAX_STR);

class Refused extends Error {}

interface St {
  nodes: number;
  keepText: boolean;
  ancestors: Set<unknown>;
}

function node(raw: unknown, depth: number, st: St): unknown {
  if (typeof raw === "boolean") return raw; // `true` / `false` subschemas
  if (!isObj(raw)) throw new Refused();
  if (depth > MAX_DEPTH || ++st.nodes > MAX_NODES) throw new Refused();
  if (st.ancestors.has(raw)) throw new Refused(); // cyclic
  st.ancestors.add(raw);
  try {
    const out: Json = {};
    const t = raw.type;
    if (typeof t === "string" && TYPES.has(t)) out.type = t;
    else if (
      Array.isArray(t) &&
      t.length > 0 &&
      t.every((x) => typeof x === "string" && TYPES.has(x))
    )
      out.type = [...t];
    for (const k of NUM_KEYS) {
      const v = raw[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    if (typeof raw.uniqueItems === "boolean") out.uniqueItems = raw.uniqueItems;
    for (const k of ["format", "pattern"] as const) {
      const v = raw[k];
      if (typeof v === "string" && v.length <= MAX_STR) out[k] = v;
    }
    if (
      Array.isArray(raw.required) &&
      raw.required.length <= MAX_LIST &&
      raw.required.every((x) => typeof x === "string" && x.length <= MAX_STR)
    )
      out.required = [...raw.required];
    if (Array.isArray(raw.enum) && raw.enum.length <= MAX_LIST && raw.enum.every(isPrim))
      out.enum = [...raw.enum];
    if (isPrim(raw.const)) out.const = raw.const;
    if (
      typeof raw.$ref === "string" &&
      raw.$ref.length <= MAX_STR &&
      /^#(\/[^\s]*)?$/.test(raw.$ref)
    )
      out.$ref = raw.$ref;
    if (st.keepText) {
      for (const k of ["description", "title"] as const) {
        const v = raw[k];
        if (typeof v === "string") out[k] = v.slice(0, MAX_TEXT);
      }
    }
    for (const k of SCHEMA_KEYS) {
      if (raw[k] !== undefined) out[k] = node(raw[k], depth + 1, st);
    }
    for (const k of SCHEMA_LIST_KEYS) {
      const v = raw[k];
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.length > MAX_LIST) throw new Refused();
      out[k] = v.map((x) => node(x, depth + 1, st));
    }
    for (const k of SCHEMA_MAP_KEYS) {
      const v = raw[k];
      if (v === undefined) continue;
      if (!isObj(v)) throw new Refused();
      const map: Json = {};
      for (const [name, sub] of Object.entries(v)) {
        if (name === "__proto__") continue;
        if (name.length > MAX_STR) throw new Refused();
        map[name] = node(sub, depth + 1, st);
      }
      out[k] = map;
    }
    return out;
  } finally {
    st.ancestors.delete(raw);
  }
}

/**
 * Sanitise a third-party JSON Schema; `undefined` means refused (cyclic, too
 * deep/large, or not an object schema at the root) — fall back to a bare object.
 */
export function sanitizeJsonSchema(raw: unknown, opts: { keepText: boolean }): Json | undefined {
  try {
    if (!isObj(raw)) return undefined;
    const st: St = { nodes: 0, keepText: opts.keepText, ancestors: new Set() };
    const out = node(raw, 0, st) as Json;
    if (JSON.stringify(out).length > MAX_SIZE) return undefined;
    // Providers require an object root; a non-object root is not describable.
    const t = out.type;
    if (t !== undefined && t !== "object") return undefined;
    return { ...out, type: "object" };
  } catch {
    return undefined;
  }
}

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

/**
 * The MINIMAL structural check for a tool whose only schema is JSON Schema: an
 * object, every `required` key present, and each declared top-level property
 * of a declared `type`. It is NOT a JSON Schema validator (no nesting, `enum`,
 * bounds, combinators): the MCP server remains the authority for those, and it
 * validates on `tools/call`. Looser than the server by construction, so it can
 * only refuse inputs the server's own schema also rejects.
 */
export function checkJsonSchemaShape(schema: Json, input: unknown): ToolInputCheck {
  const issues: ToolInputIssue[] = [];
  if (!isObj(input)) {
    return { ok: false, truncated: false, issues: [{ path: "", message: "expected an object" }] };
  }
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const k of required) {
    if (!Object.hasOwn(input, k) || input[k] === undefined)
      issues.push({ path: k.slice(0, MAX_STR), message: "required" });
  }
  const props = isObj(schema.properties) ? schema.properties : {};
  for (const [k, sub] of Object.entries(props)) {
    if (!Object.hasOwn(input, k) || input[k] === undefined || !isObj(sub)) continue;
    const t = sub.type;
    const types = typeof t === "string" ? [t] : Array.isArray(t) ? (t as string[]) : undefined;
    if (types !== undefined && !types.some((x) => typeOk(input[k], x)))
      issues.push({ path: k.slice(0, MAX_STR), message: `expected ${types.join(" | ")}` });
  }
  if (issues.length === 0) return { ok: true };
  return { ok: false, truncated: issues.length > 5, issues: issues.slice(0, 5) };
}
