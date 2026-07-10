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

function matches(spec: CronSpec, ms: number): boolean {
  const d = new Date(ms);
  return (
    spec.minutes.has(d.getUTCMinutes()) &&
    spec.hours.has(d.getUTCHours()) &&
    spec.daysOfMonth.has(d.getUTCDate()) &&
    spec.months.has(d.getUTCMonth() + 1) &&
    spec.daysOfWeek.has(d.getUTCDay())
  );
}

const MINUTE_MS = 60_000;
/** Safety bound: a valid 5-field expression always matches within 5 years. */
const MAX_SCAN_MINUTES = 5 * 366 * 24 * 60;

/**
 * The first occurrence of `spec` STRICTLY AFTER `afterMs`, in epoch ms (UTC,
 * minute granularity). Pure and deterministic — every node computes the same
 * occurrence for the same expression and instant.
 */
export function nextOccurrence(spec: CronSpec, afterMs: number): number {
  // Start at the next whole minute after `afterMs`.
  let t = (Math.floor(afterMs / MINUTE_MS) + 1) * MINUTE_MS;
  for (let i = 0; i < MAX_SCAN_MINUTES; i++, t += MINUTE_MS) {
    if (matches(spec, t)) return t;
  }
  throw new Error("cron expression never matches (scanned 5 years)");
}
