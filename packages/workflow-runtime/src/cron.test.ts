import { describe, expect, it } from "vitest";
import { nextOccurrence, parseCron } from "./cron";

const at = (iso: string) => Date.parse(iso);

describe("cron (T1.2) — minimal UTC matcher", () => {
  it("every-5-minutes steps", () => {
    const spec = parseCron("*/5 * * * *");
    expect(nextOccurrence(spec, at("2026-07-10T10:02:00Z"))).toBe(at("2026-07-10T10:05:00Z"));
    // Strictly after: an occurrence at exactly `after` yields the next one.
    expect(nextOccurrence(spec, at("2026-07-10T10:05:00Z"))).toBe(at("2026-07-10T10:10:00Z"));
  });

  it("daily at a fixed UTC time", () => {
    const spec = parseCron("30 3 * * *");
    expect(nextOccurrence(spec, at("2026-07-10T04:00:00Z"))).toBe(at("2026-07-11T03:30:00Z"));
  });

  it("lists and ranges", () => {
    const spec = parseCron("0 9-11,15 * * *");
    expect(nextOccurrence(spec, at("2026-07-10T09:30:00Z"))).toBe(at("2026-07-10T10:00:00Z"));
    expect(nextOccurrence(spec, at("2026-07-10T11:30:00Z"))).toBe(at("2026-07-10T15:00:00Z"));
  });

  it("day-of-week (0 = Sunday, UTC)", () => {
    const spec = parseCron("0 12 * * 0");
    // 2026-07-10 is a Friday; next Sunday is 2026-07-12.
    expect(nextOccurrence(spec, at("2026-07-10T00:00:00Z"))).toBe(at("2026-07-12T12:00:00Z"));
  });

  it("month + day-of-month", () => {
    const spec = parseCron("0 0 1 1 *"); // midnight UTC, Jan 1
    expect(nextOccurrence(spec, at("2026-07-10T00:00:00Z"))).toBe(at("2027-01-01T00:00:00Z"));
  });

  it("is deterministic: identical inputs → identical occurrence", () => {
    const a = nextOccurrence(parseCron("*/7 2-4 * * *"), at("2026-07-10T01:59:30Z"));
    const b = nextOccurrence(parseCron("*/7 2-4 * * *"), at("2026-07-10T01:59:30Z"));
    expect(a).toBe(b);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("a * * * *")).toThrow(/unsupported/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
  });

  // Field-jumping worst cases: a rarely-matching cron must still land on the
  // exact occurrence a minute-by-minute scan would, jumping over the ~2M
  // non-matching minutes rather than testing each.
  it("finds a leap-day occurrence years out (skips whole non-Feb months + non-29 days)", () => {
    const spec = parseCron("0 0 29 2 *"); // Feb 29, midnight UTC
    // From mid-2026 the next Feb 29 is 2028 (a leap year) — 2027 has no Feb 29.
    expect(nextOccurrence(spec, at("2026-07-10T00:00:00Z"))).toBe(at("2028-02-29T00:00:00Z"));
  });

  it("cross-checks the field-jumper against a brute-force minute scan over a year", () => {
    // An awkward multi-field expression; verify equivalence at several instants.
    const expr = "30 9,17 1,15 * 1"; // :30 past 09/17h, on the 1st or 15th, Mondays only (AND semantics)
    const spec = parseCron(expr);
    const bruteForce = (afterMs: number): number => {
      const MIN = 60_000;
      let t = (Math.floor(afterMs / MIN) + 1) * MIN;
      for (let i = 0; i < 366 * 24 * 60 * 2; i++, t += MIN) {
        const d = new Date(t);
        if (
          d.getUTCMinutes() === 30 &&
          (d.getUTCHours() === 9 || d.getUTCHours() === 17) &&
          (d.getUTCDate() === 1 || d.getUTCDate() === 15) &&
          d.getUTCDay() === 1
        )
          return t;
      }
      throw new Error("no match");
    };
    for (const from of ["2026-01-01T00:00:00Z", "2026-06-15T12:31:00Z", "2027-02-28T23:59:00Z"]) {
      expect(nextOccurrence(spec, at(from))).toBe(bruteForce(at(from)));
    }
  });
});
