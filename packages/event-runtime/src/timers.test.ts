import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteTimerStore } from "./SqliteTimerStore";
import { InMemoryTimerStore } from "./timers";
import type { TimerStore } from "./timers";

// T1.3 — timer storage contract, run against both reference backends.
function timerStoreContract(name: string, make: () => TimerStore, cleanup?: () => void) {
  describe(name, () => {
    let store: TimerStore;
    beforeEach(() => {
      store = make();
    });
    afterEach(async () => {
      await store.close();
      cleanup?.();
    });

    it("schedules and returns due timers soonest-first", async () => {
      await store.schedule({ executionId: "b", wakeAt: 200 });
      await store.schedule({ executionId: "a", wakeAt: 100 });
      await store.schedule({ executionId: "c", wakeAt: 900 });

      const due = await store.due(500);
      expect(due).toEqual([
        { executionId: "a", wakeAt: 100 },
        { executionId: "b", wakeAt: 200 },
      ]);
    });

    it("schedule is idempotent per (executionId, wakeAt)", async () => {
      await store.schedule({ executionId: "a", wakeAt: 100 });
      await store.schedule({ executionId: "a", wakeAt: 100 });
      expect((await store.due(500)).length).toBe(1);
    });

    it("complete retires a timer; unknown timers are a no-op", async () => {
      await store.schedule({ executionId: "a", wakeAt: 100 });
      await store.complete("a", 100);
      expect(await store.due(500)).toEqual([]);
      await expect(store.complete("nope", 1)).resolves.toBeUndefined();
    });

    it("respects the due limit", async () => {
      for (let i = 0; i < 5; i++) await store.schedule({ executionId: `e${i}`, wakeAt: i });
      expect((await store.due(100, 3)).length).toBe(3);
    });
  });
}

timerStoreContract("InMemoryTimerStore", () => new InMemoryTimerStore());

describe("SqliteTimerStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-timers-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  timerStoreContract("contract", () => new SqliteTimerStore(join(dir ?? tmpdir(), "timers.db")));

  it("persists across store instances (restart survival)", async () => {
    const path = join(dir, "persist.db");
    const first = new SqliteTimerStore(path);
    await first.schedule({ executionId: "x", wakeAt: 42 });
    await first.close();

    const second = new SqliteTimerStore(path);
    expect(await second.due(100)).toEqual([{ executionId: "x", wakeAt: 42 }]);
    await second.close();
  });
});
