import { describe, expect, it } from "vitest";
import { z } from "zod";
import { pathsOfClass, secret, sensitive } from "./classify";
import { expandPaths, hasWildcard } from "./expand";
import { maskPaths } from "./redact";

describe("expandPaths", () => {
  it("leaves wildcard-free paths exactly as they are (G2)", () => {
    // Including paths absent from the value: the appliers already skip those, and expansion
    // must not start filtering them or pre-existing behaviour shifts.
    expect(expandPaths({ a: 1 }, ["a", "a.b.c", "nope"])).toEqual(["a", "a.b.c", "nope"]);
  });

  it("expands one index per element", () => {
    const value = { people: [{ ssn: "1" }, { ssn: "2" }, { ssn: "3" }] };
    expect(expandPaths(value, ["people[].ssn"])).toEqual([
      "people.0.ssn",
      "people.1.ssn",
      "people.2.ssn",
    ]);
  });

  it("expands a marked array ELEMENT type", () => {
    expect(expandPaths({ tags: ["a", "b"] }, ["tags[]"])).toEqual(["tags.0", "tags.1"]);
  });

  it("expands nested and array-of-array crossings", () => {
    const value = { teams: [{ m: [{ s: 1 }, { s: 2 }] }, { m: [{ s: 3 }] }] };
    expect(expandPaths(value, ["teams[].m[].s"])).toEqual([
      "teams.0.m.0.s",
      "teams.0.m.1.s",
      "teams.1.m.0.s",
    ]);
    expect(expandPaths({ grid: [[{ v: 1 }], [{ v: 2 }, { v: 3 }]] }, ["grid[][].v"])).toEqual([
      "grid.0.0.v",
      "grid.1.0.v",
      "grid.1.1.v",
    ]);
  });

  it("expands to nothing when the wildcard does not resolve", () => {
    expect(expandPaths({}, ["people[].ssn"])).toEqual([]);
    expect(expandPaths({ people: null }, ["people[].ssn"])).toEqual([]);
    expect(expandPaths({ people: [] }, ["people[].ssn"])).toEqual([]);
    // `[]` over a non-array is a schema/value mismatch, not an index into a string.
    expect(expandPaths({ people: "nope" }, ["people[].ssn"])).toEqual([]);
  });

  it("skips elements missing the leaf, and holes", () => {
    const value = { people: [{ ssn: "1" }, { other: true }] };
    expect(expandPaths(value, ["people[].ssn"])).toEqual(["people.0.ssn"]);
  });

  it("hasWildcard gates the fast path", () => {
    expect(hasWildcard(["a.b", "c"])).toBe(false);
    expect(hasWildcard(["a.b", "c[].d"])).toBe(true);
  });
});

describe("marks under arrays now reach the sinks (#260)", () => {
  it("masks every element and preserves array-ness", () => {
    const schema = z.object({
      people: z.array(z.object({ ssn: sensitive(z.string()), id: z.string() })),
    });
    const value = {
      people: [
        { ssn: "111", id: "a" },
        { ssn: "222", id: "b" },
      ],
    };
    const masked = maskPaths(value, pathsOfClass(schema, "sensitive"));
    expect(masked).toEqual({
      people: [
        { ssn: "[redacted]", id: "a" },
        { ssn: "[redacted]", id: "b" },
      ],
    });
    // The spine copy must not turn the array into `{0:…,1:…}` — that would break every
    // downstream consumer that maps over it.
    expect(Array.isArray((masked as { people: unknown }).people)).toBe(true);
  });

  it("does not mutate the input", () => {
    const value = { people: [{ ssn: "111" }] };
    const schema = z.object({ people: z.array(z.object({ ssn: sensitive(z.string()) })) });
    maskPaths(value, pathsOfClass(schema, "sensitive"));
    expect(value.people[0]?.ssn).toBe("111");
  });

  it("collects `[]` paths from the schema walker", () => {
    const schema = z.object({
      people: z.array(z.object({ ssn: sensitive(z.string()) })),
      tokens: z.array(secret(z.string())),
      plain: z.string(),
    });
    expect(pathsOfClass(schema, "sensitive")).toEqual(["people[].ssn"]);
    expect(pathsOfClass(schema, "secret")).toEqual(["tokens[]"]);
  });

  it("still masks a marked array as a whole unit", () => {
    const schema = z.object({ people: sensitive(z.array(z.object({ ssn: z.string() }))) });
    expect(pathsOfClass(schema, "sensitive")).toEqual(["people"]);
    expect(maskPaths({ people: [{ ssn: "1" }] }, pathsOfClass(schema, "sensitive"))).toEqual({
      people: "[redacted]",
    });
  });
});
