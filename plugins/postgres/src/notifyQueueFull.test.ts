import type { EventEnvelope } from "@loomwork/core";
import { DuplicateSequenceError, StaleFenceError } from "@loomwork/event-runtime";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { postgresStorage } from "./preset";

// A full NOTIFY queue fails the whole commit, and Postgres only allows the queue's size to be set
// at server start, so a shared test server cannot be filled. `QueueFullPool` raises the same error
// from the same place: pg_notify succeeds and the COMMIT fails, with nothing landed.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL ? describe : describe.skip;

function queueFull(): Error {
  return Object.assign(new Error("too many notifications in the NOTIFY queue"), { code: "54000" });
}

class QueueFullPool extends Pool {
  /** "open": NOTIFY works. "stale": full until the usage call frees it. "hung": stays full. */
  queue: "open" | "stale" | "hung" = "open";
  usageCalls = 0;
  failedCommits = 0;
  notifies = 0;

  private carriesNotify(text: unknown): boolean {
    return typeof text === "string" && text.includes("pg_notify");
  }

  override query(...args: unknown[]): never {
    const text = args[0];
    if (typeof text === "string" && text.includes("pg_notification_queue_usage")) {
      this.usageCalls++;
      if (this.queue === "stale") this.queue = "open";
    }
    if (this.carriesNotify(text)) {
      if (this.queue !== "open") {
        this.failedCommits++;
        return Promise.reject(queueFull()) as never;
      }
      this.notifies++;
    }
    return (super.query as (...a: unknown[]) => never)(...args);
  }

  override connect(...args: unknown[]): never {
    // pg's own Pool.query passes a callback here. Those statements are already seen by `query`.
    if (typeof args[0] === "function")
      return (super.connect as (...a: unknown[]) => never)(...args);
    const pending = (super.connect as (...a: unknown[]) => Promise<PoolClient>)();
    return pending.then((client) => {
      const real = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      let notified = false;
      const wrapped = (...a: unknown[]): Promise<unknown> => {
        if (this.carriesNotify(a[0])) notified = true;
        if (a[0] === "COMMIT" && notified && this.queue !== "open") {
          notified = false;
          this.failedCommits++;
          return real("ROLLBACK").then(() => Promise.reject(queueFull()));
        }
        if (a[0] === "COMMIT" && notified) this.notifies++;
        return real(...a);
      };
      (client as unknown as { query: unknown }).query = wrapped;
      const release = client.release.bind(client);
      client.release = (err?: Error | boolean) => {
        (client as unknown as { query: unknown }).query = real;
        client.release = release;
        release(err);
      };
      return client;
    }) as never;
  }
}

function envelope(executionId: string, sequence: number): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType: "STEP_STARTED",
    sequence,
    timestamp: 1,
    payload: { n: sequence },
  };
}

suite("PostgresEventStore when the NOTIFY queue is full", () => {
  let pool: QueueFullPool;
  let store: PostgresEventStore;
  let warnings: string[];
  let now: number;
  let run = 0;
  const prefix = `queue-full-${Date.now()}`;
  const id = (): string => `${prefix}-${run}`;

  beforeAll(() => {
    pool = new QueueFullPool({ connectionString: PG_URL, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    run++;
    now = 1_000_000;
    warnings = [];
    pool.queue = "open";
    store = new PostgresEventStore(pool as never, {
      onWarn: (m) => warnings.push(m),
      clock: () => now,
    });
    await store.append(envelope(id(), 0));
    pool.usageCalls = 0;
    pool.failedCommits = 0;
    pool.notifies = 0;
  });

  const stored = async (): Promise<number[]> =>
    (await store.read(id())).map((event) => event.sequence);

  it("a healthy queue never makes the extra call", async () => {
    await store.append(envelope(id(), 1));
    expect(pool.notifies).toBe(1);
    expect(pool.usageCalls).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("a queue left full by a dead listener is freed, and the write keeps its NOTIFY", async () => {
    pool.queue = "stale";
    await store.append(envelope(id(), 1));
    expect(await stored()).toEqual([0, 1]);
    expect(pool.usageCalls).toBe(1);
    expect(pool.notifies).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("appendBatch and appendIfUnchanged also free a queue left full by a dead listener", async () => {
    pool.queue = "stale";
    await store.appendBatch([envelope(id(), 1), envelope(id(), 2)]);
    expect(pool.usageCalls).toBe(1);
    expect(await stored()).toEqual([0, 1, 2]);

    const seen = await store.appendIfUnchanged(id(), null);
    if (seen.appended) throw new Error("an observation appends nothing");
    pool.queue = "stale";
    const landed = await store.appendIfUnchanged(id(), envelope(id(), 3), {
      head: seen.head as number,
      fence: seen.fence,
      anchor: seen.anchor as string,
    });
    expect(landed.appended).toBe(true);
    expect(pool.usageCalls).toBe(2);
    expect(await stored()).toEqual([0, 1, 2, 3]);
    expect(warnings).toEqual([]);
  });

  it("a throwing warning sink does not report a landed write as failed", async () => {
    const throwing = new PostgresEventStore(pool as never, {
      onWarn: () => {
        throw new Error("sink down");
      },
      clock: () => now,
    });
    pool.queue = "hung";
    await throwing.append(envelope(id(), 1));
    expect(await stored()).toEqual([0, 1]);
  });

  it("postgresStorage passes onWarn to the event store", async () => {
    const seen: string[] = [];
    const storage = postgresStorage({ url: pool as never, onWarn: (m) => seen.push(m) });
    await storage.eventStore.append(envelope(id(), 1));
    pool.queue = "hung";
    await storage.eventStore.append(envelope(id(), 2));
    expect(seen).toHaveLength(1);
    expect(await stored()).toEqual([0, 1, 2]);
  });

  it("a hung listener costs the wake-up and not the write, and warns", async () => {
    pool.queue = "hung";
    await store.append(envelope(id(), 1));
    expect(await stored()).toEqual([0, 1]);
    expect(pool.failedCommits).toBe(2);
    expect(pool.notifies).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/NOTIFY queue is full/);
  });

  it("appendBatch keeps its events and all-or-nothing behaviour", async () => {
    pool.queue = "hung";
    await store.appendBatch([envelope(id(), 1), envelope(id(), 2)]);
    expect(await stored()).toEqual([0, 1, 2]);
    await expect(store.appendBatch([envelope(id(), 3), envelope(id(), 2)])).rejects.toThrow();
    expect(await stored()).toEqual([0, 1, 2]);
  });

  it("appendIfUnchanged lands once, with its guard intact", async () => {
    const seen = await store.appendIfUnchanged(id(), null);
    if (seen.appended) throw new Error("an observation appends nothing");
    const expectTip = {
      head: seen.head as number,
      fence: seen.fence,
      anchor: seen.anchor as string,
    };
    pool.queue = "hung";
    const landed = await store.appendIfUnchanged(id(), envelope(id(), 1), expectTip);
    expect(landed.appended).toBe(true);
    expect(pool.failedCommits).toBe(2);
    expect(await stored()).toEqual([0, 1]);
    const moved = await store.appendIfUnchanged(id(), envelope(id(), 2), expectTip);
    expect(moved).toMatchObject({ appended: false, reason: "moved" });
    expect(await stored()).toEqual([0, 1]);
  });

  it("a taken slot and a stale fence are still reported", async () => {
    pool.queue = "hung";
    await store.append(envelope(id(), 1));
    await expect(
      store.append({ ...envelope(id(), 1), id: `${id()}-other` })
    ).rejects.toBeInstanceOf(DuplicateSequenceError);
    await store.acquireFence(id());
    await expect(store.append(envelope(id(), 2))).rejects.toBeInstanceOf(StaleFenceError);
    expect(await stored()).toEqual([0, 1]);
  });

  it("skips NOTIFY during the pause, then tries again and recovers", async () => {
    pool.queue = "hung";
    await store.append(envelope(id(), 1));
    expect(pool.failedCommits).toBe(2);
    await store.append(envelope(id(), 2));
    expect(pool.failedCommits).toBe(2);

    now += 5_000;
    pool.queue = "open";
    await store.append(envelope(id(), 3));
    expect(pool.notifies).toBe(1);
    expect(await stored()).toEqual([0, 1, 2, 3]);
  });

  it("warns at most once a minute", async () => {
    pool.queue = "hung";
    for (let sequence = 1; sequence <= 3; sequence++) {
      await store.append(envelope(id(), sequence));
      now += 5_000;
    }
    expect(warnings).toHaveLength(1);
    now += 60_000;
    await store.append(envelope(id(), 4));
    expect(warnings).toHaveLength(2);
  });

  it("a different 54000 still reaches the caller", async () => {
    const original = pool.query.bind(pool);
    const other = Object.assign(new Error("index row size exceeds maximum"), { code: "54000" });
    pool.query = ((...args: unknown[]) =>
      typeof args[0] === "string" && args[0].includes("INSERT INTO events")
        ? Promise.reject(other)
        : (original as (...a: unknown[]) => unknown)(...args)) as never;
    try {
      await expect(store.append(envelope(id(), 1))).rejects.toBe(other);
    } finally {
      pool.query = original;
    }
    expect(await stored()).toEqual([0]);
    expect(warnings).toEqual([]);
  });
});
