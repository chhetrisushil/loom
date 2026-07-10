// ── T1.2 — a minimal, dependency-free cron matcher (UTC) ─────────────────────
//
// 5 fields: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12),
// day-of-week (0-6, 0 = Sunday). Each field supports:
//   *        any value
//   */n      steps
//   a        a single value
//   a-b      an inclusive range
//   a,b,c    lists (of values or ranges)
// Evaluated in UTC so every node computes identical occurrences (determinism —
// a schedule's occurrence times must not depend on node timezone).

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
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`invalid cron "${expr}": expected 5 fields (min hour dom mon dow)`);
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map((f, i) =>
    parseField(f, FIELDS[i] as FieldSpec, expr)
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

const MINUTE_MS = 60_000;
/** Safety bound: a valid 5-field expression always matches within 5 years. */
const MAX_SCAN_MINUTES = 5 * 366 * 24 * 60;

/**
 * The first occurrence of `spec` STRICTLY AFTER `afterMs`, in epoch ms (UTC,
 * minute granularity). Pure and deterministic — every node computes the same
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
