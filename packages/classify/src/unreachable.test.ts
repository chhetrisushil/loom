import { describe, expect, it } from "vitest";
import { z } from "zod";
import { internal, pathsOfClass, secret, sensitive } from "./classify";
import { maskPaths } from "./redact";
import { collectUnreachableMarks } from "./unreachable";

// The detector audits `collectMarkedPaths`, so the two must agree on what is reachable.
// A false positive here is worse than the gap it reports: it would tell a developer their
// working mark is broken. So most of these assert the detector against what masking
// ACTUALLY does, not against a hand-written expectation.
const masks = (schema: z.ZodTypeAny, value: unknown): unknown =>
  maskPaths(value, [...pathsOfClass(schema, "sensitive"), ...pathsOfClass(schema, "internal")]);

describe("collectUnreachableMarks", () => {
  it("finds a mark inside an array element — the silent no-op", () => {
    const schema = z.object({ people: z.array(z.object({ ssn: sensitive(z.string()) })) });
    expect(collectUnreachableMarks(schema)).toEqual([
      { path: "people[].ssn", dataClass: "sensitive", reason: "under-array" },
    ]);
    // Confirm the gap is real rather than assumed: masking leaves the value untouched.
    const masked = masks(schema, { people: [{ ssn: "123-45-6789" }] }) as {
      people: { ssn: string }[];
    };
    expect(masked.people[0]?.ssn).toBe("123-45-6789");
  });

  it("stays silent when the ARRAY itself is marked — the supported spelling", () => {
    const schema = z.object({ people: sensitive(z.array(z.object({ ssn: z.string() }))) });
    expect(collectUnreachableMarks(schema)).toEqual([]);
    // And that spelling genuinely masks.
    expect(masks(schema, { people: [{ ssn: "123" }] })).toEqual({ people: "[redacted]" });
  });

  it("stays silent for ordinary reachable marks", () => {
    const schema = z.object({
      ssn: sensitive(z.string()),
      user: z.object({ email: sensitive(z.string()), id: z.string() }),
      note: internal(z.string()),
      token: secret(z.string()),
    });
    expect(collectUnreachableMarks(schema)).toEqual([]);
    expect(
      masks(schema, { ssn: "a", user: { email: "b", id: "c" }, note: "d", token: "e" })
    ).toEqual({
      ssn: "[redacted]",
      user: { email: "[redacted]", id: "c" },
      note: "[redacted]",
      token: "e",
    });
  });

  it("reports every class, not just sensitive", () => {
    const schema = z.object({
      rows: z.array(z.object({ k: secret(z.string()), n: internal(z.number()) })),
    });
    expect(collectUnreachableMarks(schema)).toEqual([
      { path: "rows[].k", dataClass: "secret", reason: "under-array" },
      { path: "rows[].n", dataClass: "internal", reason: "under-array" },
    ]);
  });

  it("sees through optional / nullable / default wrappers, as the walker does", () => {
    const schema = z.object({
      a: z.array(z.object({ x: sensitive(z.string()).optional() })).optional(),
      b: z.object({ y: sensitive(z.string()).nullable() }),
    });
    const found = collectUnreachableMarks(schema);
    expect(found).toEqual([{ path: "a[].x", dataClass: "sensitive", reason: "under-array" }]);
    // `b.y` is reachable and really is masked, so it must not be reported.
    expect(masks(schema, { b: { y: "secret" } })).toEqual({ b: { y: "[redacted]" } });
  });

  it("handles nested and array-of-array shapes", () => {
    const schema = z.object({
      teams: z.array(z.object({ members: z.array(z.object({ ssn: sensitive(z.string()) })) })),
      grid: z.array(z.array(z.object({ v: internal(z.string()) }))),
    });
    expect(collectUnreachableMarks(schema)).toEqual([
      { path: "teams[].members[].ssn", dataClass: "sensitive", reason: "under-array" },
      { path: "grid[][].v", dataClass: "internal", reason: "under-array" },
    ]);
  });

  it("does not double-report a mark nested inside a marked object", () => {
    // The outer mark already covers the subtree — reporting the inner one would tell a
    // developer to fix something the coarser mark handles.
    const schema = z.object({
      rows: z.array(sensitive(z.object({ ssn: sensitive(z.string()) }))),
    });
    expect(collectUnreachableMarks(schema)).toEqual([
      { path: "rows[]", dataClass: "sensitive", reason: "under-array" },
    ]);
  });

  it("is empty for an unmarked schema and for a non-object root", () => {
    expect(collectUnreachableMarks(z.object({ a: z.string() }))).toEqual([]);
    expect(collectUnreachableMarks(z.string())).toEqual([]);
    expect(collectUnreachableMarks(z.array(z.string()))).toEqual([]);
  });
});
