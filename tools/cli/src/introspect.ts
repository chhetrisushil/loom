import { formatIntrospection, introspect } from "@loom/analytics";
import { type StoreFlags, resolveStores } from "./stores";

/**
 * `loom introspect --db <path> <executionId> [--graph <name>]` — the read-only
 * runtime introspection facade (ADR 0031). Prints the execution / task / decision /
 * resource graphs folded from one execution's log; `--graph` selects one.
 */
export async function cmdIntrospect(
  flags: StoreFlags,
  executionId: string,
  graph?: string
): Promise<string> {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await store.read(executionId);
    if (events.length === 0) return `(no execution "${executionId}")`;
    return formatIntrospection(introspect(events, executionId), graph);
  } finally {
    await resolved.close();
  }
}
