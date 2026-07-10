import { advisoryPipeline, formatAdvisory } from "@loom/analytics";
import { SqliteEventStore } from "@loom/event-runtime";

/**
 * `loom optimize --db <path> <executionId>` — the advisory optimization report (ADR 0034):
 * observe → analyze → recommend → evaluate → learn, over one execution's log. Read-only and
 * advisory; it never mutates anything (adoption is an explicit ctx.decide in app code).
 */
export async function cmdOptimize(db: string, executionId: string): Promise<string> {
  const store = new SqliteEventStore(db);
  try {
    const events = await store.read(executionId);
    if (events.length === 0) return `(no execution "${executionId}")`;
    return formatAdvisory(advisoryPipeline(events));
  } finally {
    await store.close();
  }
}
