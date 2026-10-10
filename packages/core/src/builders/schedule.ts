import type { ScheduleDefinition } from "../types/definitions";

export interface ScheduleConfig<TIn> {
  id: string;
  /** 5-field cron (min hour dom mon dow), evaluated in `timeZone` (default UTC). */
  cron: string;
  /** R19 - IANA zone for the cron fields (e.g. `"Europe/Berlin"`); default UTC. An unknown zone throws here. */
  timeZone?: string;
  /** The registered flow id each occurrence starts. */
  flowId: string;
  input?: TIn;
}

/** UTC offset (minutes) of `timeZone` at `at`, from its wall-clock parts. */
function offsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return Math.round((wall - at.getTime()) / 60000);
}

/**
 * True when `timeZone` observes DST. Judged on a FIXED year (2024: Jan 1 vs Jul 1 offsets differ)
 * so the answer never depends on the clock, and covers both hemispheres.
 */
function observesDst(timeZone: string): boolean {
  return (
    offsetMinutes(timeZone, new Date(Date.UTC(2024, 0, 1))) !==
    offsetMinutes(timeZone, new Date(Date.UTC(2024, 6, 1)))
  );
}

/** True when the cron can fire more than once within an hour-of-day, or in every hour. */
function firesWithinEveryHour(cron: string): boolean {
  const [minute = "", hour = ""] = cron.trim().split(/\s+/);
  return !/^\d+$/.test(minute) || hour.startsWith("*") || hour.includes("/");
}

const warnedSchedules = new Set<string>();

/**
 * ADR 0126 D5: the fall-back hour's second pass is skipped by design, so a sub-hourly or hourly
 * expression in a DST zone silently loses it. Say so at definition time. The check is conservative
 * (any non-fixed minute, or a wildcard / stepped hour, in a zone that observes DST), so it can warn for
 * a schedule that is unaffected, and it fires once per schedule id per process. `console.warn` because
 * core has no warning sink.
 */
function warnHourlyInDstZone(config: { id: string; cron: string; timeZone?: string }): void {
  const { id, cron, timeZone } = config;
  if (timeZone === undefined || warnedSchedules.has(id)) return;
  if (!firesWithinEveryHour(cron) || !observesDst(timeZone)) return;
  warnedSchedules.add(id);
  console.warn(
    `[loom] schedule "${id}": cron "${cron}" can fire more than once in a repeated (fall-back) hour in "${timeZone}", which observes DST. A repeated hour runs only its first pass (ADR 0126); this check is conservative and may warn for a schedule that is unaffected. Use UTC for fixed-interval schedules.`
  );
}

/**
 * T1.2 — declare a durable cron schedule, statically wired per P5. Register it
 * via `defineConfig({ timers: { schedules: [...] } })` (or hand it to a
 * `TimerService`); each due occurrence starts the flow with a deterministic
 * `scheduleId@occurrence` executionId, so firing is at-least-once but starts
 * are idempotent.
 */
export function schedule$<TIn = unknown>(config: ScheduleConfig<TIn>): ScheduleDefinition<TIn> {
  if (config.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: config.timeZone });
    } catch {
      throw new Error(
        `schedule "${config.id}": unknown time zone "${String(config.timeZone)}" (expected an IANA name such as "Europe/Berlin")`
      );
    }
  }
  warnHourlyInDstZone(config);
  return {
    _tag: "ScheduleDefinition",
    id: config.id,
    cron: config.cron,
    ...(config.timeZone !== undefined && { timeZone: config.timeZone }),
    flowId: config.flowId,
    ...(config.input !== undefined && { input: config.input }),
  };
}
