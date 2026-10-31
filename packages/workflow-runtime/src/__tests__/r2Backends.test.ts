import type { postgresPool } from "@loom/plugin-postgres";
import { describe, expect, it } from "vitest";
import { inboxBackends } from "./r2Backends";

// loom #718: teardown must not deadlock with background work (an inbox retire) that still holds
// row locks on the shared pool. The overlap is made deterministic by holding a transaction open on
// the backend's own pool, exactly as a retire's `fences` -> `events` transaction does.
const backend = inboxBackends("r2backends")[2];

describe.skipIf(backend.skip === true)("inboxBackends postgres teardown", () => {
  it("waits for an in-flight transaction on the pool, then drops the schema without deadlocking", async () => {
    await backend.setup();
    const { eventStore } = backend.make();
    const pool = (eventStore as unknown as { pool: ReturnType<typeof postgresPool> }).pool;
    const client = await pool.connect();
    await client.query("BEGIN");
    // the retire's first statements: take the fences row locks ...
    await client.query("SELECT fence FROM fences WHERE execution_id = 'x' FOR UPDATE");
    await client.query("DELETE FROM fences WHERE execution_id = 'x'");

    let tornDown = false;
    const td = backend.teardown().then(() => {
      tornDown = true;
    });
    // ... and only THEN the events delete, after teardown has begun (the deadlock's second edge)
    await client.query("DELETE FROM events WHERE execution_id = 'x'");
    await client.query("COMMIT");
    expect(tornDown).toBe(false); // teardown is parked behind the checked-out client
    client.release();
    await td; // completes: no deadlock, schema dropped
    expect(tornDown).toBe(true);
  });
});
