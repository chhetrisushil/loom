# @loom/fair-scheduler — per-tenant fair scheduling

A drop-in replacement for `@loom/scheduler`'s `createScheduler` that, when work queues behind a
concurrency cap, dispatches with **weighted round-robin across tenants** — so no single tenant can
starve the others. It implements the same `Scheduler` interface, so it slots into any consumer.

> Single-tenant / `Infinity` workloads behave exactly as the base scheduler (zero-overhead fast path
> preserved). See [ADR 0038](../../docs/adr/0038-per-tenant-fair-scheduler.md).

```ts
import { createFairScheduler } from "@loom/fair-scheduler";

const scheduler = createFairScheduler({ concurrency: 8 });

await scheduler.schedule(runTask, { tenant: "acme", priority: Priority.Normal });
await scheduler.schedule(runTask, { tenant: "globex", weight: 2 }); // 2× dispatch turns
```

## Policy

- **Per-tenant lanes** — each tenant has its own priority-ordered lane.
- **Weighted round-robin** — when a slot frees, the dispatcher advances a rotation (each tenant
  repeated `weight` times) to the next non-empty lane, so busy tenants can't monopolize the cap.
- **Within a lane** — `(priority, arrival)` order, identical to the base scheduler.
- **Fast path** — `concurrency: Infinity` (default) disables all gating; `schedule` just awaits the
  task, exactly like the base scheduler.

## Scope

Ephemeral, like the base scheduler — it governs live fan-out, not durable pause/resume (Loom's
event-sourcing owns that). Fairness is over *queued* tasks; a running task is not preempted.
Starvation-freedom holds because the rotation always advances past the tenant it just served.
