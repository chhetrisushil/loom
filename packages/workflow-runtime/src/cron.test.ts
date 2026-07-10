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
});
