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

// FNV-1a-64 over UTF-8 bytes — pure JS, sync, dependency-free. 64 bits is
// drift-detection grade (pairwise miss ~2^-64 at registry scale) where the
// compiler's 32-bit shortHash is not. Cross-language stability comes from
// hashing the UTF-8 BYTES of the canonical string, not UTF-16 code units.
//
// Four 16-bit limbs in plain Number arithmetic (the "two-lane Math.imul" follow-up
// PERF-B1 deferred until a hot-path caller existed — `ctx.emit` digests every
// flow-level emit, ADR 0102). The FNV prime is 2^40 + 0x1b3, so the multiply is
// `h·0x1b3 + (h << 40)`: every partial product stays below 2^27, carries propagate
// limb to limb, and the result is bit-identical to the BigInt reference (pinned by a
// randomized differential test) at a fraction of the cost — no BigInt per byte.
const UTF8 = new TextEncoder();

export function fnv1a64(text: string): string {
  const bytes = UTF8.encode(text);
  // offset basis 0xcbf29ce484222325, low limb first
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i] as number;
    const t0 = h0 * 0x1b3;
    let t1 = h1 * 0x1b3;
    let t2 = h2 * 0x1b3 + (h0 << 8); // h0·2^40 lands in limb 2, shifted 8
    const t3 = h3 * 0x1b3 + (h1 << 8);
    t1 += t0 >>> 16;
    h0 = t0 & 0xffff;
    t2 += t1 >>> 16;
    h1 = t1 & 0xffff;
    h3 = (t3 + (t2 >>> 16)) & 0xffff;
    h2 = t2 & 0xffff;
  }
  return (
    h3.toString(16).padStart(4, "0") +
    h2.toString(16).padStart(4, "0") +
    h1.toString(16).padStart(4, "0") +
    h0.toString(16).padStart(4, "0")
  );
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
