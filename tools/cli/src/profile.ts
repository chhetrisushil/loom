import { formatProfile, profile } from "@loom/analytics";
import { type StoreFlags, noSuchExecution, resolveStores } from "./stores";

/**
 * `loom profile --db <path> <executionId>` — a flame graph + latency breakdown for
 * one execution (ADR 0029). Read-only over the durable log; opens the store, folds
 * the events into a profile, prints it. "DevTools for Loom" in the terminal.
 */
export async function cmdProfile(flags: StoreFlags, executionId: string): Promise<string> {
  return formatProfile(await profileOf(flags, executionId));
}

/** The structured profile (`loom profile --json`). */
export async function profileOf(flags: StoreFlags, executionId: string) {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await store.read(executionId);
    if (events.length === 0) throw await noSuchExecution(store, executionId);
    return profile(events, executionId);
  } finally {
    await resolved.close();
  }
}
