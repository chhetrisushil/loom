import { bench, describe } from "vitest";
import { createScheduler } from "./scheduler";
import { parallelLimit } from "./structured";

// Guardrail bench: the unbounded scheduler must add negligible overhead over a
// direct await, and parallelLimit at/above the task count must track Promise.all.
// Compare the pairs in each `describe` block; the scheduler variant should sit
// within a few percent of the raw baseline.

const noop = () => Promise.resolve(1);

describe("schedule overhead (unbounded)", () => {
  const sched = createScheduler();

  bench("direct await (baseline)", async () => {
    await noop();
  });

  bench("scheduler.schedule (Infinity)", async () => {
    await sched.schedule(noop);
  });
});

describe("fan-out of 8", () => {
  const tasks = Array.from({ length: 8 }, () => noop);

  bench("Promise.all (baseline)", async () => {
    await Promise.all(tasks.map((t) => t()));
  });

  bench("parallelLimit (unbounded)", async () => {
    await parallelLimit(tasks);
  });

  bench("parallelLimit (limit 4)", async () => {
    await parallelLimit(tasks, { limit: 4 });
  });
});
