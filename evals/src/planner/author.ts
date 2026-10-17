import { PLANNER_CASES } from "./cases";
import { authorPlannerCassette, store } from "./measure";

// Regenerate every planner cassette from the hand-written scripts in `cases.ts`: the REAL `IntentRuntime` and
// `PlannerRuntime` run over the script and each request/response pair is stored. Offline and keyless.

export async function authorPlanner(log: (line: string) => void = console.log): Promise<void> {
  for (const c of PLANNER_CASES) {
    const data = await authorPlannerCassette(c);
    store.write(c.id, data);
    log(`authored planner/${c.id}: ${Object.keys(data).length} exchange(s)`);
  }
}
