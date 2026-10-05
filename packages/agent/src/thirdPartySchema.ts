/**
 * R4b — a THIRD PARTY's JSON Schema (an MCP server's `inputSchema`) is bytes we
 * did not write that are about to be placed in a model prompt. This module
 * turns it into something safe to send.
 *
 * Sanitisation is an ALLOWLIST of JSON Schema keywords (everything else —
 * `x-*` extensions, `default`, `examples`, `$comment`, `$id`, `$schema`, … — is
 * dropped), under hard bounds: depth {@link MAX_DEPTH}, {@link MAX_NODES}
 * schema nodes, free text capped at {@link MAX_TEXT}. A cyclic structure, or one
 * past any bound, is REFUSED as a whole (`undefined`); the caller falls back to
 * `{ type: "object" }` and warns. It never throws. Nothing is ever fetched:
 * a remote `$ref` is dropped (the node becomes permissive).
 *
 * Free text (`description`, `title`) is stripped unless the caller states trust
 * (`keepText`): it is read as instructions by every provider (ADR 0085). What
 * remains textual and is NOT removable without destroying the schema is
 * constrained so it cannot carry prose: property / `$defs` / `definitions` keys
 * must be identifier-shaped ({@link NAME_RE}, else the entry is dropped and its
 * `required` mention with it); `enum`/`const` strings are at most
 * {@link MAX_VALUE} chars with no control / zero-width / bidi characters (else
 * the keyword is dropped); `format` is from JSON Schema's standard list;
 * `pattern` must compile (never run); a `$ref` survives only if it names a kept
 * `$defs`/`definitions` entry (or `#`). A total budget of
 * {@link MAX_ATTACKER_CHARS} characters across all of those refuses the whole
 * schema. A hostile server can still say a few words inside the budget; the
 * description is the default-deny surface, this is the bound on the rest.
 */

const MAX_DEPTH = 16;
const MAX_NODES = 1000;
const MAX_STR = 200;
const MAX_TEXT = 1000;
const MAX_LIST = 100;
const MAX_SIZE = 64 * 1024;
/** Property / `$defs` / `definitions` keys must look like identifiers, not sentences. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** `enum` / `const` strings and `pattern` are capped tighter than free text. */
const MAX_VALUE = 64;
const MAX_PATTERN = 128;
/**
 * Total attacker-controlled characters one schema may carry (names, `$defs` keys,
 * `enum`/`const` strings, `pattern`, `format`, `$ref`). Past it the whole schema
 * is refused. Without it the per-item caps still admit ~64KB of prose per tool.
 */
export const MAX_ATTACKER_CHARS = 4096;
/** Control, format (zero-width, bidi) and line/paragraph-separator characters. */
const HIDDEN_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** JSON Schema's standard `format` vocabulary (draft 2020-12 section 7.3). */
const FORMATS = new Set([
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
]);

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
  (typeof v === "string" && v.length <= MAX_VALUE && !HIDDEN_RE.test(v));

class Refused extends Error {}

interface St {
  nodes: number;
  keepText: boolean;
  ancestors: Set<unknown>;
  /** Attacker-controlled characters kept so far (see {@link MAX_ATTACKER_CHARS}). */
  chars: number;
  /** Output nodes carrying a `$ref`, resolved against the kept `$defs` at the end. */
  refs: Json[];
}

/** Charge `n` attacker characters against the budget; over it, refuse the schema. */
function spend(st: St, n: number): void {
  st.chars += n;
  if (st.chars > MAX_ATTACKER_CHARS) throw new Refused();
}

const validPattern = (p: string): boolean => {
  if (p.length > MAX_PATTERN || HIDDEN_RE.test(p)) return false;
  try {
    new RegExp(p, "u"); // compiled to prove it is a regex; NEVER executed
    return true;
  } catch {
    return false;
  }
};

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
    if (typeof raw.format === "string" && FORMATS.has(raw.format)) out.format = raw.format;
    if (typeof raw.pattern === "string" && validPattern(raw.pattern)) {
      spend(st, raw.pattern.length);
      out.pattern = raw.pattern;
    }
    if (Array.isArray(raw.enum) && raw.enum.length <= MAX_LIST && raw.enum.every(isPrim)) {
      for (const x of raw.enum) if (typeof x === "string") spend(st, x.length);
      out.enum = [...raw.enum];
    }
    if (isPrim(raw.const)) {
      if (typeof raw.const === "string") spend(st, raw.const.length);
      out.const = raw.const;
    }
    // A same-document pointer to the root (`#`) or to a `$defs`/`definitions`
    // entry; whether the entry SURVIVED is decided once the tree is built.
    if (
      typeof raw.$ref === "string" &&
      (raw.$ref === "#" || /^#\/(\$defs|definitions)\/[A-Za-z0-9_.-]{1,64}$/.test(raw.$ref))
    ) {
      out.$ref = raw.$ref;
      st.refs.push(out);
    }
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
        // A key that is not identifier-shaped is dropped, not kept: a sentence
        // in a property name is prompt text. Dropping one entry degrades a tool
        // less than refusing its whole schema, and `required` is pruned below.
        if (!NAME_RE.test(name)) continue;
        spend(st, name.length);
        map[name] = node(sub, depth + 1, st);
      }
      out[k] = map;
    }
    // `required` names only properties that survived: a name nothing declares
    // is either dropped attacker text or a dangling claim.
    if (Array.isArray(raw.required) && raw.required.length <= MAX_LIST) {
      const props = isObj(out.properties) ? out.properties : {};
      const req = raw.required.filter(
        (x): x is string => typeof x === "string" && Object.hasOwn(props, x)
      );
      if (req.length > 0) out.required = [...new Set(req)];
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
    const st: St = { nodes: 0, keepText: opts.keepText, ancestors: new Set(), chars: 0, refs: [] };
    const out = node(raw, 0, st) as Json;
    // A `$ref` to a `$defs`/`definitions` entry that was dropped (or never
    // existed) is dangling — providers 400 on it — so it is removed.
    for (const r of st.refs) {
      const ref = r.$ref as string;
      if (ref === "#") continue;
      const [, section, name] = ref.split("/") as [string, string, string];
      const defs = out[section];
      if (!isObj(defs) || !Object.hasOwn(defs, name)) Reflect.deleteProperty(r, "$ref");
    }
    if (JSON.stringify(out).length > MAX_SIZE) return undefined;
    // Providers require an object root; a non-object root is not describable.
    const t = out.type;
    if (t !== undefined && t !== "object") return undefined;
    return { ...out, type: "object" };
  } catch {
    return undefined;
  }
}
