import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTimerStore } from "./timers";
import type { TimerStore } from "./timers";

// T1.3 — timer storage contract. Run here against the in-memory reference; the
// SQLite backend runs the same contract in @loom/plugin-sqlite (ADR 0043).
export function timerStoreContract(name: string, make: () => TimerStore, cleanup?: () => void) {
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
