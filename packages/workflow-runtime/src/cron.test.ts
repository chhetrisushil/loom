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

describe("cron timeZone (R19) - IANA zones, DST-correct, no deps", () => {
  const next = (expr: string, tz: string | undefined, after: string) =>
    new Date(nextOccurrence(parseCron(expr, tz), at(after))).toISOString();

  it("defaults to UTC, and an explicit 'UTC' is the same", () => {
    expect(next("30 3 * * *", undefined, "2026-07-10T04:00:00Z")).toBe("2026-07-11T03:30:00.000Z");
    expect(next("30 3 * * *", "UTC", "2026-07-10T04:00:00Z")).toBe("2026-07-11T03:30:00.000Z");
  });

  it("evaluates every field on the zone's wall clock (offset, half-hour zone, date line)", () => {
    // Kolkata is UTC+5:30: 09:00 local = 03:30Z.
    expect(next("0 9 * * *", "Asia/Kolkata", "2026-07-10T00:00:00Z")).toBe(
      "2026-07-10T03:30:00.000Z"
    );
    // Tokyo midnight is 15:00Z of the PREVIOUS UTC day.
    expect(next("0 0 * * *", "Asia/Tokyo", "2026-07-10T00:00:00Z")).toBe(
      "2026-07-10T15:00:00.000Z"
    );
    // Day-of-week is the local one: Monday 09:00 in Tokyo is Sunday 00:00Z.
    expect(next("0 9 * * 1", "Asia/Tokyo", "2026-07-10T00:00:00Z")).toBe(
      "2026-07-13T00:00:00.000Z"
    );
  });

  it("follows the offset across DST: 09:00 New York is 13:00Z in summer, 14:00Z in winter", () => {
    expect(next("0 9 * * *", "America/New_York", "2026-07-10T00:00:00Z")).toBe(
      "2026-07-10T13:00:00.000Z"
    );
    expect(next("0 9 * * *", "America/New_York", "2026-12-10T00:00:00Z")).toBe(
      "2026-12-10T14:00:00.000Z"
    );
  });

  it("spring forward: a wall time that does not exist runs once, shifted forward by the gap", () => {
    // 2026-03-08 02:00 -> 03:00 in New York: 02:30 does not exist, so it runs at 03:30 EDT (= 02:30 EST = 07:30Z).
    expect(next("30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z")).toBe(
      "2026-03-08T07:30:00.000Z"
    );
    // The day after is an ordinary 02:30 EDT = 06:30Z, and the one before an ordinary 02:30 EST = 07:30Z.
    expect(next("30 2 * * *", "America/New_York", "2026-03-08T07:30:00Z")).toBe(
      "2026-03-09T06:30:00.000Z"
    );
    expect(next("30 2 * * *", "America/New_York", "2026-03-06T12:00:00Z")).toBe(
      "2026-03-07T07:30:00.000Z"
    );
    // Europe: 2026-03-29 02:00 -> 03:00 in Berlin; 02:30 CET = 01:30Z.
    expect(next("30 2 * * *", "Europe/Berlin", "2026-03-28T12:00:00Z")).toBe(
      "2026-03-29T01:30:00.000Z"
    );
  });

  it("fall back: a repeated wall time runs once, at its FIRST occurrence", () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST in New York: 01:30 happens at 05:30Z (EDT) and 06:30Z (EST).
    expect(next("30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z")).toBe(
      "2026-11-01T05:30:00.000Z"
    );
    // After the first, the repeat is skipped: the next run is the following day's 01:30 EST.
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z")).toBe(
      "2026-11-02T06:30:00.000Z"
    );
    // Even polled from inside the repeated hour.
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T06:00:00Z")).toBe(
      "2026-11-02T06:30:00.000Z"
    );
    // Europe: 2026-10-25 03:00 CEST -> 02:00 CET; 02:30 happens at 00:30Z (CEST) then 01:30Z (CET).
    expect(next("30 2 * * *", "Europe/Berlin", "2026-10-24T12:00:00Z")).toBe(
      "2026-10-25T00:30:00.000Z"
    );
    expect(next("30 2 * * *", "Europe/Berlin", "2026-10-25T00:30:00Z")).toBe(
      "2026-10-26T01:30:00.000Z"
    );
  });

  it("is strictly increasing through both transitions, minute by minute schedule included", () => {
    for (const [tz, from] of [
      ["America/New_York", "2026-03-07T00:00:00Z"],
      ["America/New_York", "2026-10-31T00:00:00Z"],
      ["Australia/Lord_Howe", "2026-10-03T00:00:00Z"],
    ] as const) {
      const spec = parseCron("*/15 * * * *", tz);
      let t = at(from);
      for (let i = 0; i < 400; i++) {
        const n = nextOccurrence(spec, t);
        expect(n).toBeGreaterThan(t);
        t = n;
      }
    }
  });

  it("rejects an unknown or malformed zone at parse time", () => {
    expect(() => parseCron("0 0 * * *", "Mars/Olympus")).toThrow(
      /unknown time zone "Mars\/Olympus"/
    );
    expect(() => parseCron("0 0 * * *", "")).toThrow(/time zone/);
  });
});
