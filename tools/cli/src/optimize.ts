import { advisoryPipeline, formatAdvisory } from "@loom/analytics";
import { type StoreFlags, noSuchExecution, resolveStores } from "./stores";

/**
 * `loom optimize --db <path> <executionId>` — the advisory optimization report (ADR 0034):
 * observe → analyze → recommend → evaluate → learn, over one execution's log. Read-only and
 * advisory; it never mutates anything (adoption is an explicit ctx.decide in app code).
 */
export async function cmdOptimize(flags: StoreFlags, executionId: string): Promise<string> {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await store.read(executionId);
    if (events.length === 0) throw await noSuchExecution(store, executionId);
    return formatAdvisory(advisoryPipeline(events));
  } finally {
    await resolved.close();
  }
}
