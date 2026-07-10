import type { ScheduleDefinition } from "../types/definitions";

export interface ScheduleConfig<TIn> {
  id: string;
  /** 5-field cron (min hour dom mon dow), evaluated in UTC. */
  cron: string;
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
  return {
    _tag: "ScheduleDefinition",
    id: config.id,
    cron: config.cron,
    flowId: config.flowId,
    ...(config.input !== undefined && { input: config.input }),
  };
}
