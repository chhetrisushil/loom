import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  classOf,
  collectClassifiedPaths,
  internal,
  pathsOfClass,
  secret,
  sensitive,
  strictest,
} from "./classify";
import { externalized, externalizedPaths, isExternalized } from "./external";

describe("classify — markers (K10-R1)", () => {
  it("returns the SAME schema instance (validation untouched)", () => {
    const base = z.string();
    const marked = sensitive(base);
    expect(marked).toBe(base);
    expect(marked.parse("ok")).toBe("ok");
    expect(() => marked.parse(42)).toThrow();
  });

  it("reads back the class each marker set", () => {
    expect(classOf(secret(z.string()))).toBe("secret");
    expect(classOf(sensitive(z.string()))).toBe("sensitive");
    expect(classOf(internal(z.string()))).toBe("internal");
    expect(classOf(z.string())).toBeUndefined();
    expect(classOf("not a schema")).toBeUndefined();
  });
});

describe("classify — walker (K10-R1)", () => {
  it("collects nested classified paths in declaration order", () => {
    const schema = z.object({
      id: z.string(),
      user: z.object({
        name: internal(z.string()),
        ssn: sensitive(z.string()),
      }),
      token: secret(z.string()),
    });
    expect(collectClassifiedPaths(schema)).toEqual([
      { path: "user.name", dataClass: "internal" },
      { path: "user.ssn", dataClass: "sensitive" },
      { path: "token", dataClass: "secret" },
    ]);
  });

  it("sees a marker through optional/nullable/default/effects wrappers", () => {
    const schema = z.object({
      a: sensitive(z.string()).optional(),
      b: sensitive(z.string()).nullable(),
      c: sensitive(z.string().default("x")),
      d: sensitive(z.string()).refine(() => true),
    });
    expect(pathsOfClass(schema, "sensitive").sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("treats a classified object as a unit and does not descend into it", () => {
    const schema = z.object({
      address: sensitive(z.object({ street: internal(z.string()), zip: z.string() })),
    });
    // The whole subtree encrypts as one; the inner `internal` mark is NOT also emitted.
    expect(collectClassifiedPaths(schema)).toEqual([{ path: "address", dataClass: "sensitive" }]);
  });

  it("filters to one class with pathsOfClass", () => {
    const schema = z.object({
      pw: secret(z.string()),
      email: sensitive(z.string()),
      note: internal(z.string()),
    });
    expect(pathsOfClass(schema, "secret")).toEqual(["pw"]);
    expect(pathsOfClass(schema, "sensitive")).toEqual(["email"]);
  });

  it("returns nothing for an unclassified schema", () => {
    expect(collectClassifiedPaths(z.object({ a: z.string(), b: z.number() }))).toEqual([]);
  });
});

describe("classify — strictest", () => {
  it("picks the most-restrictive class (secret > sensitive > internal)", () => {
    expect(strictest("internal", "secret")).toBe("secret");
    expect(strictest("sensitive", "internal")).toBe("sensitive");
    expect(strictest(undefined, "internal")).toBe("internal");
    expect(strictest("sensitive", undefined)).toBe("sensitive");
    expect(strictest(undefined, undefined)).toBeUndefined();
  });
});

describe("externalized marker (ADR 0046)", () => {
  it("returns the same schema and reads back the mark", () => {
    const base = z.string();
    const marked = externalized(base);
    expect(marked).toBe(base);
    expect(marked.parse("ok")).toBe("ok");
    expect(isExternalized(marked)).toBe(true);
    expect(isExternalized(z.string())).toBe(false);
    expect(isExternalized("not a schema")).toBe(false);
  });

  it("collects externalized paths, incl. through wrappers and a marked object as a unit", () => {
    const schema = z.object({
      id: z.string(),
      doc: externalized(z.object({ title: z.string(), body: z.string() })),
      attachment: externalized(z.string()).optional(),
      small: z.string(),
    });
    expect(externalizedPaths(schema).sort()).toEqual(["attachment", "doc"]);
  });

  it("is orthogonal to the sensitivity taxonomy — a field can be both", () => {
    // A large AND sensitive document: externalize the bytes, and encrypt them.
    const schema = z.object({ report: externalized(sensitive(z.string())) });
    expect(externalizedPaths(schema)).toEqual(["report"]);
    expect(pathsOfClass(schema, "sensitive")).toEqual(["report"]);
  });

  it("returns nothing for an unmarked schema", () => {
    expect(externalizedPaths(z.object({ a: z.string() }))).toEqual([]);
  });
});
