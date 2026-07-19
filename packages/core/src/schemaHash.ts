// ── ADR 0063 — canonical JSON + the schema hash ───────────────────────────────
//
// ONE canonicalization + ONE hash, imported by everything that pins or verifies
// tool schemas (the MCP plugin's drift check, a registry change-detector, the
// sandbox's output-shape pin). Two implementations that "mostly agree" is how
// registry-driven repair becomes unreliable — hence core, dependency-free, and
// platform-neutral (no node:crypto; TextEncoder is web+node).
//
// Canonical form (an RFC 8785-style subset sufficient for JSON Schema
// documents): lexicographically sorted object keys, no whitespace, arrays in
// order, JSON.stringify scalar formatting, `undefined` object members omitted
// (as JSON.stringify does), `undefined` array elements serialized as `null`
// (as JSON.stringify does). Non-JSON values (function, symbol, bigint,
// non-finite numbers) throw — a schema document must be plain data.
//
// Audit hardening: depth-capped (a hostile listTools response must degrade to a
// catchable TypeError, not a host stack overflow — SEC-3), and no per-node path
// strings on the success path (PERF-B2).

const MAX_DEPTH = 1024;

export function canonicalJson(value: unknown): string {
  return canon(value, 0);
}

function canon(value: unknown, depth: number): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonicalJson: non-finite number");
      }
      return JSON.stringify(value);
    case "object": {
      if (depth >= MAX_DEPTH) {
        throw new TypeError(`canonicalJson: depth limit exceeded (${MAX_DEPTH})`);
      }
      if (Array.isArray(value)) {
        const parts = value.map((v) => (v === undefined ? "null" : canon(v, depth + 1)));
        return `[${parts.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      const parts = keys.map((k) => `${JSON.stringify(k)}:${canon(record[k], depth + 1)}`);
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

// FNV-1a-64 over UTF-8 bytes (BigInt — pure JS, sync, dependency-free). 64 bits
// is drift-detection grade (pairwise miss ~2^-64 at registry scale) where the
// compiler's 32-bit shortHash is not. Cross-language stability comes from
// hashing the UTF-8 BYTES of the canonical string, not UTF-16 code units.
// Warm-path constants (audit PERF-B1): module-level encoder, indexed loop, and
// a 256-entry BigInt table so the per-byte cost is one table read + xor + mul
// (no BigInt allocation per byte). A two-lane Math.imul formulation would be
// ~20-50× faster still; deferred until a hot-path caller exists (ADR 0065
// discipline — measured need, not speculation).
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const UTF8 = new TextEncoder();
const BYTE_BIGINTS: readonly bigint[] = Array.from({ length: 256 }, (_, i) => BigInt(i));

export function fnv1a64(text: string): string {
  const bytes = UTF8.encode(text);
  let h = FNV64_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BYTE_BIGINTS[bytes[i] as number] as bigint;
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * The canonical fingerprint of a JSON Schema document (or any plain-JSON
 * value): `fnv1a64:<hex16>` over the canonical JSON form. Key order never
 * matters; any semantic change does. Pin it at plan time, verify at execution
 * time, fail typed (`schemaDrift`, ADR 0060/0063) on mismatch.
 */
export function jsonSchemaHash(schema: unknown): string {
  return `fnv1a64:${fnv1a64(canonicalJson(schema))}`;
}
