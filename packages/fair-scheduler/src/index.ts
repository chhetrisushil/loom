// @loom/fair-scheduler — per-tenant fair scheduling.
//
// A drop-in `Scheduler` (the @loom/scheduler interface) that dispatches queued work
// with weighted round-robin across tenants behind a concurrency cap, so no single
// tenant can starve the others. Single-tenant / Infinity workloads behave exactly as
// the base scheduler (zero-overhead fast path preserved).

export {
  type FairScheduleOptions,
  type FairSchedulerConfig,
  createFairScheduler,
} from "./fairScheduler";
