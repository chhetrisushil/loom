import { describe, expect, it } from "vitest";
import { z } from "zod";
import { internal, pathsOfClass, secret, sensitive } from "./classify";
import { maskPaths } from "./redact";
import { collectUnreachableMarks } from "./unreachable";

// The detector audits `collectMarkedPaths`, so the two must agree on what is reachable.
// A false positive here is worse than the gap it reports: it would tell a developer their
// working mark is broken. So the reachable cases assert the detector against what masking
// ACTUALLY does, not against a hand-written expectation.
const masks = (schema: z.ZodTypeAny, value: unknown): unknown =>
  maskPaths(value, [...pathsOfClass(schema, "sensitive"), ...pathsOfClass(schema, "internal")]);

describe("collectUnreachableMarks", () => {
  it("stays silent for marks under arrays — those are reachable now", () => {
    const schema = z.object({ people: z.array(z.object({ ssn: sensitive(z.string()) })) });
    expect(collectUnreachableMarks(schema)).toEqual([]);
    // Not merely assumed reachable: masking really reaches it.
    expect(masks(schema, { people: [{ ssn: "123-45-6789" }, { ssn: "9" }] })).toEqual({
      people: [{ ssn: "[redacted]" }, { ssn: "[redacted]" }],
    });
  });

  it("finds a mark under a record — the remaining silent no-op", () => {
    const schema = z.object({ byId: z.record(z.object({ ssn: sensitive(z.string()) })) });
    expect(collectUnreachableMarks(schema)).toEqual([
      { path: "byId.<record>.ssn", dataClass: "sensitive", container: "record" },
    ]);
    // Confirm the gap is real rather than assumed: masking leaves the value untouched.
    const masked = masks(schema, { byId: { a: { ssn: "123-45-6789" } } }) as {
      byId: Record<string, { ssn: string }>;
    };
    expect(masked.byId.a?.ssn).toBe("123-45-6789");
  });

  it("finds marks under a union, a tuple and an intersection", () => {
    const union = z.object({
      v: z.union([z.object({ k: secret(z.string()) }), z.object({ n: z.number() })]),
    });
    expect(collectUnreachableMarks(union)).toEqual([
      { path: "v.<union>.k", dataClass: "secret", container: "union" },
    ]);

    const tuple = z.object({ pair: z.tuple([z.string(), z.object({ e: sensitive(z.string()) })]) });
    expect(collectUnreachableMarks(tuple)).toEqual([
      { path: "pair.<tuple>.e", dataClass: "sensitive", container: "tuple" },
    ]);

    const inter = z.object({
      both: z.intersection(z.object({ a: internal(z.string()) }), z.object({ b: z.string() })),
    });
    expect(collectUnreachableMarks(inter)).toEqual([
      { path: "both.<intersection>.a", dataClass: "internal", container: "intersection" },
    ]);
  });

  it("reaches marks stranded under a record nested inside an array", () => {
    // Arrays are traversable, records are not — the array crossing must not mask the blocker.
    const schema = z.object({
      rows: z.array(z.object({ meta: z.record(z.object({ k: secret(z.string()) })) })),
    });
    expect(collectUnreachableMarks(schema)).toEqual([
      { path: "rows[].meta.<record>.k", dataClass: "secret", container: "record" },
    ]);
  });

  it("names the OUTERMOST blocker when containers nest", () => {
    // Fixing the inner one changes nothing while the outer record still strands it.
    const schema = z.object({
      m: z.record(z.union([z.object({ s: sensitive(z.string()) }), z.string()])),
    });
    const [found] = collectUnreachableMarks(schema);
    expect(found?.container).toBe("record");
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

  it("sees through optional / nullable / default wrappers, as the walker does", () => {
    const schema = z.object({
      a: z.record(z.object({ x: sensitive(z.string()).optional() })).optional(),
      b: z.object({ y: sensitive(z.string()).nullable() }),
    });
    expect(collectUnreachableMarks(schema)).toEqual([
      { path: "a.<record>.x", dataClass: "sensitive", container: "record" },
    ]);
    // `b.y` is reachable and really is masked, so it must not be reported.
    expect(masks(schema, { b: { y: "secret" } })).toEqual({ b: { y: "[redacted]" } });
  });

  it("does not double-report a mark nested inside a marked object", () => {
    // The outer mark already covers the subtree — reporting the inner one would tell a
    // developer to fix something the coarser mark handles.
    const schema = z.object({
      rows: z.record(sensitive(z.object({ ssn: sensitive(z.string()) }))),
    });
    expect(collectUnreachableMarks(schema)).toEqual([
      { path: "rows.<record>", dataClass: "sensitive", container: "record" },
    ]);
  });

  it("is empty for an unmarked schema and for a non-object root", () => {
    expect(collectUnreachableMarks(z.object({ a: z.string() }))).toEqual([]);
    expect(collectUnreachableMarks(z.string())).toEqual([]);
    expect(collectUnreachableMarks(z.array(z.string()))).toEqual([]);
    // An unmarked record is not a finding — only a stranded MARK is.
    expect(collectUnreachableMarks(z.object({ m: z.record(z.string()) }))).toEqual([]);
  });
});
