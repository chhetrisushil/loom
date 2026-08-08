import { PostgresEventStore } from "@loom/plugin-postgres";

/**
 * A subscriber "node" for scenario H, run as its own PROCESS.
 *
 * Scenario C approximates fan-out with idle `LISTEN` connections in the bench's own
 * process. That measures the notification traffic but not what a real node does with it:
 * a genuine subscriber holds a `PostgresEventStore`, and `onNotify` issues a `SELECT` per
 * delivered notification to fetch the event row. Only a separate process running the real
 * store exercises that, and only then does the writer see a realistic multi-node load.
 *
 * Protocol over `process.send` / `process.on("message")`:
 *   parent → child   { type: "stop" }
 *   child  → parent  { type: "ready" } | { type: "report", delivered, executions }
 *
 * Argv: <pgUrl> <executionId>[,<executionId>…]
 */
async function main(): Promise<void> {
  const [pgUrl, idsCsv] = process.argv.slice(2);
  if (pgUrl === undefined || idsCsv === undefined) {
    throw new Error("usage: subscriberChild <pgUrl> <executionIds,csv>");
  }
  const executionIds = idsCsv.split(",").filter((s) => s.length > 0);

  const store = new PostgresEventStore(pgUrl);
  let delivered = 0;
  const unsubscribes = await Promise.all(
    executionIds.map((id) =>
      store.subscribe(id, () => {
        delivered++;
      })
    )
  );

  const shutdown = async (): Promise<void> => {
    for (const un of unsubscribes) un();
    // Report BEFORE closing: the parent needs the count, and close() tears down the
    // listener connection this process exists to hold.
    process.send?.({ type: "report", delivered, executions: executionIds.length });
    await store.close();
    process.exit(0);
  };

  process.on("message", (msg: { type?: string }) => {
    if (msg?.type === "stop") void shutdown();
  });

  // Ready only once every subscription is live, so the parent never starts writing into a
  // window where this node would miss notifications and under-report fan-out.
  process.send?.({ type: "ready" });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
