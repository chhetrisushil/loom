import { formatIntrospection, introspect } from "@loom/analytics";
import { UsageError } from "./args";
import { type StoreFlags, noSuchExecution, resolveStores } from "./stores";

/** The graphs `formatIntrospection` can render (validated up front so a typo exits 2). */
const GRAPH_NAMES = ["executions", "tasks", "decisions", "resources"] as const;

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
  return formatIntrospection(await introspectionOf(flags, executionId, graph), graph);
}

/** The structured graphs (`loom introspect --json`); `--graph` selects one key. */
export async function introspectionOf(flags: StoreFlags, executionId: string, graph?: string) {
  if (graph !== undefined && !(GRAPH_NAMES as readonly string[]).includes(graph)) {
    throw new UsageError(`unknown graph "${graph}" — choose one of: ${GRAPH_NAMES.join(", ")}`);
  }
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await store.read(executionId);
    if (events.length === 0) throw await noSuchExecution(store, executionId);
    return introspect(events, executionId);
  } finally {
    await resolved.close();
  }
}
