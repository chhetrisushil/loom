import { describe, expect, it } from "vitest";
import { canonicalJson, fnv1a64, jsonSchemaHash } from "./schemaHash";

// A real MCP-style tool inputSchema fixture.
const MCP_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "metric query" },
    range: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from"],
    },
    limit: { type: "number" },
  },
  required: ["query"],
};

describe("canonicalJson (ADR 0063)", () => {
  it("is key-order invariant, whitespace-free, and array-order preserving", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
    expect(canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });

  it("mirrors JSON.stringify for undefined members/elements and unicode strings", () => {
    expect(canonicalJson({ a: 1, gone: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
    expect(canonicalJson({ s: "héllo " })).toBe(`{"s":${JSON.stringify("héllo ")}}`);
  });

  it("throws on non-JSON values", () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ b: 10n })).toThrow(TypeError);
  });
});

describe("jsonSchemaHash (ADR 0063)", () => {
  it("pins known vectors (cross-implementation stability)", () => {
    // FNV-1a-64 reference vectors over UTF-8 bytes of the canonical form.
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(jsonSchemaHash({})).toBe(`fnv1a64:${fnv1a64("{}")}`);
  });

  it("is stable under key reordering of a real MCP inputSchema", () => {
    const reordered = JSON.parse(canonicalJson(MCP_INPUT_SCHEMA));
    const shuffled = {
      required: ["query"],
      properties: {
        limit: { type: "number" },
        range: {
          required: ["from"],
          properties: { to: { type: "string" }, from: { type: "string" } },
          type: "object",
        },
        query: { description: "metric query", type: "string" },
      },
      type: "object",
    };
    expect(jsonSchemaHash(shuffled)).toBe(jsonSchemaHash(MCP_INPUT_SCHEMA));
    expect(jsonSchemaHash(reordered)).toBe(jsonSchemaHash(MCP_INPUT_SCHEMA));
  });

  it("detects drift: any semantic change moves the hash", () => {
    const base = jsonSchemaHash(MCP_INPUT_SCHEMA);
    const widened = {
      ...MCP_INPUT_SCHEMA,
      properties: { ...MCP_INPUT_SCHEMA.properties, tenant: { type: "string" } },
    };
    const retyped = JSON.parse(JSON.stringify(MCP_INPUT_SCHEMA)) as typeof MCP_INPUT_SCHEMA;
    retyped.properties.limit.type = "string";
    expect(jsonSchemaHash(widened)).not.toBe(base);
    expect(jsonSchemaHash(retyped)).not.toBe(base);
  });
});

// ADR 0102 — the limb implementation must be bit-identical to the BigInt definition.
function fnv1a64Reference(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

describe("fnv1a64 — limb arithmetic equals the BigInt definition", () => {
  it("matches on fixed and randomized inputs, including multi-byte UTF-8", () => {
    const fixed = ["", "a", "foobar", "\u00e9\u4e2d\ud83d\ude00", "x".repeat(10_000)];
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const random = Array.from({ length: 500 }, () =>
      String.fromCharCode(...Array.from({ length: rand() % 64 }, () => rand() % 0xd7ff))
    );
    for (const text of [...fixed, ...random]) {
      expect(fnv1a64(text)).toBe(fnv1a64Reference(text));
    }
  });
});
