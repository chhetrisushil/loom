import { formatProfile, profile } from "@loom/analytics";
import { SqliteEventStore } from "@loom/plugin-sqlite";

/**
 * `loom profile --db <path> <executionId>` — a flame graph + latency breakdown for
 * one execution (ADR 0029). Read-only over the durable log; opens the store, folds
 * the events into a profile, prints it. "DevTools for Loom" in the terminal.
 */
export async function cmdProfile(db: string, executionId: string): Promise<string> {
  const store = new SqliteEventStore(db);
  try {
    const events = await store.read(executionId);
    if (events.length === 0) return `(no execution "${executionId}")`;
    return formatProfile(profile(events, executionId));
  } finally {
    await store.close();
  }
}
