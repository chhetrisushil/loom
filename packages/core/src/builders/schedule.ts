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
  return {
    _tag: "ScheduleDefinition",
    id: config.id,
    cron: config.cron,
    ...(config.timeZone !== undefined && { timeZone: config.timeZone }),
    flowId: config.flowId,
    ...(config.input !== undefined && { input: config.input }),
  };
}
