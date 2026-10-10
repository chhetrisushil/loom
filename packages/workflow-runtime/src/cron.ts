// ── T1.2 — a minimal, dependency-free cron matcher (UTC) ─────────────────────
//
// 5 fields: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12),
// day-of-week (0-6, 0 = Sunday). Each field supports:
//   *        any value
//   */n      steps
//   a        a single value
//   a-b      an inclusive range
//   a,b,c    lists (of values or ranges)
// Evaluated in UTC by default so every node computes identical occurrences
// (determinism — a schedule's occurrence times must not depend on the NODE's
// timezone). R19: a spec may carry an explicit IANA `timeZone`; the five fields
// are then read on that zone's wall clock. The zone is DATA on the schedule, not
// the node's, so every node still computes identical occurrences. See
// `nextOccurrence` for the DST rules.

interface FieldSpec {
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week
];

function parseField(field: string, spec: FieldSpec, expr: string): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const base = stepMatch ? (stepMatch[1] as string) : part;
    if (step <= 0) throw new Error(`invalid cron "${expr}": step must be positive in "${part}"`);

    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (/^\d+-\d+$/.test(base)) {
      const [a, b] = base.split("-").map(Number) as [number, number];
      lo = a;
      hi = b;
    } else if (/^\d+$/.test(base)) {
      lo = Number(base);
      hi = lo;
    } else {
      throw new Error(`invalid cron "${expr}": unsupported field part "${part}"`);
    }
    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(`invalid cron "${expr}": "${part}" out of range ${spec.min}-${spec.max}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** IANA zone the fields are read in (R19). Absent = UTC. */
  timeZone?: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    // Throws RangeError for an unknown zone.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Throws unless `timeZone` is an IANA zone this runtime knows. */
export function assertTimeZone(timeZone: string): void {
  try {
    if (typeof timeZone !== "string" || timeZone.length === 0) throw new RangeError("empty");
    formatter(timeZone);
  } catch {
    throw new Error(
      `invalid cron: unknown time zone "${String(timeZone)}" (expected an IANA name such as "Europe/Berlin")`
    );
  }
}

/** The zone's UTC offset at instant `ms`, in ms (local wall time = ms + offset). */
function offsetMs(timeZone: string, ms: number): number {
  const second = Math.floor(ms / 1000) * 1000;
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(second)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return (
    Date.UTC(p.year as number, (p.month as number) - 1, p.day, p.hour, p.minute, p.second) - second
  );
}

const DAY_MS = 86_400_000;

/**
 * The instant a wall-clock reading (`wall`, expressed as if it were UTC) happens in `timeZone`.
 * - Ordinary reading: its one instant.
 * - Repeated reading (fall-back): the FIRST instant, so a schedule runs once.
 * - Nonexistent reading (spring-forward gap): the instant it WOULD have been under the offset in
 *   force before the gap, i.e. shifted forward by the gap (02:30 in a 02:00->03:00 gap runs at 03:30).
 */
function wallToInstant(timeZone: string, wall: number): number {
  const before = wall - offsetMs(timeZone, wall - DAY_MS);
  const after = wall - offsetMs(timeZone, wall + DAY_MS);
  const okBefore = before + offsetMs(timeZone, before) === wall;
  const okAfter = after + offsetMs(timeZone, after) === wall;
  if (okBefore && okAfter) return Math.min(before, after);
  if (okBefore) return before;
  if (okAfter) return after;
  return before;
}

export function parseCron(expr: string, timeZone?: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`invalid cron "${expr}": expected 5 fields (min hour dom mon dow)`);
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map((f, i) =>
    parseField(f, FIELDS[i] as FieldSpec, expr)
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (timeZone !== undefined) assertTimeZone(timeZone);
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    ...(timeZone !== undefined && timeZone !== "UTC" && { timeZone }),
  };
}

const MINUTE_MS = 60_000;
/** Safety bound: a valid 5-field expression always matches within 5 years. */
const MAX_SCAN_MINUTES = 5 * 366 * 24 * 60;

/**
 * The first occurrence of `spec` STRICTLY AFTER `afterMs`, in epoch ms (minute
 * granularity; the fields are read in UTC, or in `spec.timeZone` when set).
 *
 * DST rules for a zoned spec (a fixed WALL-CLOCK schedule runs once per day it matches):
 * - spring forward - a matched wall time inside the skipped hour does not exist; it runs once,
 *   shifted forward by the gap (`30 2 * * *` over 02:00->03:00 runs at 03:30).
 * - fall back - a matched wall time in the repeated hour runs once, at its FIRST occurrence.
 * Consequence: a sub-hourly or hourly expression (`0 * * * *`) skips the repeated hour's second
 * pass; use UTC for fixed-interval schedules. Pure and deterministic — every node computes the same
 * occurrence for the same expression and instant.
 *
 * Field-jumping, not minute-stepping: when a coarser field (month/day/hour)
 * fails, every finer instant within it provably fails too, so we jump straight
 * to the start of the next candidate month/day/hour instead of testing each of
 * its (up to ~44 000) minutes. This yields the SAME instant a minute-by-minute
 * scan would — every skipped minute is one that cannot match — while turning a
 * worst case of ~2.6M `Date` allocations (e.g. a leap-day cron, or a daily job
 * polled once a minute past its time) into at most a few thousand.
 */
export function nextOccurrence(spec: CronSpec, afterMs: number): number {
  const tz = spec.timeZone;
  if (tz === undefined) return nextUtcOccurrence(spec, afterMs);
  // The scan runs on the zone's WALL clock (the UTC field-jumping below, fed wall readings), and each
  // match is converted back to an instant. Wall readings can map to instants out of order only near a
  // transition (a gap-shifted reading lands after readings that follow it), so when one is within
  // 3 h of `afterMs` the scan starts 3 h of wall time earlier and keeps the first instant > afterMs.
  const here = offsetMs(tz, afterMs);
  const nearTransition =
    offsetMs(tz, afterMs - 3 * 3_600_000) !== here ||
    offsetMs(tz, afterMs + 3 * 3_600_000) !== here;
  let wall = afterMs + here - (nearTransition ? 3 * 3_600_000 : 0);
  for (let i = 0; i < 100_000; i++) {
    wall = nextUtcOccurrence(spec, wall);
    const instant = wallToInstant(tz, wall);
    if (instant > afterMs) return instant;
  }
  throw new Error("cron expression never matches (scanned 5 years)");
}

function nextUtcOccurrence(spec: CronSpec, afterMs: number): number {
  const startMs = (Math.floor(afterMs / MINUTE_MS) + 1) * MINUTE_MS;
  const limitMs = startMs + MAX_SCAN_MINUTES * MINUTE_MS;
  let t = startMs;
  while (t < limitMs) {
    const d = new Date(t);
    const year = d.getUTCFullYear();
    const month0 = d.getUTCMonth(); // 0-indexed for Date.UTC
    if (!spec.months.has(month0 + 1)) {
      // Whole month excluded → jump to 00:00 of the 1st of the next month.
      t = Date.UTC(year, month0 + 1, 1, 0, 0, 0);
      continue;
    }
    const date = d.getUTCDate();
    if (!(spec.daysOfMonth.has(date) && spec.daysOfWeek.has(d.getUTCDay()))) {
      // Whole day excluded → jump to 00:00 of the next day.
      t = Date.UTC(year, month0, date + 1, 0, 0, 0);
      continue;
    }
    const hour = d.getUTCHours();
    if (!spec.hours.has(hour)) {
      // Whole hour excluded → jump to :00 of the next hour.
      t = Date.UTC(year, month0, date, hour + 1, 0, 0);
      continue;
    }
    if (!spec.minutes.has(d.getUTCMinutes())) {
      t += MINUTE_MS; // this minute excluded → the next one
      continue;
    }
    return t; // all five fields match
  }
  throw new Error("cron expression never matches (scanned 5 years)");
}
