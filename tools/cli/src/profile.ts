import { formatProfile, profile } from "@loom/analytics";
import { type StoreFlags, resolveStores } from "./stores";

/**
 * `loom profile --db <path> <executionId>` — a flame graph + latency breakdown for
 * one execution (ADR 0029). Read-only over the durable log; opens the store, folds
 * the events into a profile, prints it. "DevTools for Loom" in the terminal.
 */
export async function cmdProfile(flags: StoreFlags, executionId: string): Promise<string> {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await store.read(executionId);
    if (events.length === 0) return `(no execution "${executionId}")`;
    return formatProfile(profile(events, executionId));
  } finally {
    await resolved.close();
  }
}
