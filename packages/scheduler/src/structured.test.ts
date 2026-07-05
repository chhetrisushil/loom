import { describe, expect, it } from "vitest";
import { parallelLimit } from "./structured";

const delay = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

describe("parallelLimit", () => {
  it("returns results in INPUT order regardless of completion order", async () => {
    const results = await parallelLimit([
      () => delay(20, "a"),
      () => delay(1, "b"),
      () => delay(10, "c"),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const make = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5, null);
      active--;
      return active;
    };
    await parallelLimit([make(), make(), make(), make(), make()], { limit: 2 });
    expect(peak).toBe(2);
  });

  it("handles an empty task list", async () => {
    expect(await parallelLimit([])).toEqual([]);
  });

  it("failFast aborts siblings and rejects with the first error", async () => {
    const started: number[] = [];
    let thirdStarted = false;
    await expect(
      parallelLimit(
        [
          async () => {
            started.push(0);
            await delay(1, null);
            throw new Error("boom");
          },
          async (signal) => {
            started.push(1);
            // Long task that should observe the abort.
            await delay(50, null);
            if (signal.aborted) throw new Error("aborted-1");
            return 1;
          },
          async () => {
            // With limit 2, this only starts once a slot frees; by then failFast
            // should have stopped the pool.
            thirdStarted = true;
            return 2;
          },
        ],
        { limit: 2 }
      )
    ).rejects.toThrow("boom");
    expect(thirdStarted).toBe(false);
  });

  it("failFast:false runs everything and throws the first-by-order error", async () => {
    let ran = 0;
    await expect(
      parallelLimit(
        [
          async () => {
            ran++;
            throw new Error("first");
          },
          async () => {
            ran++;
            throw new Error("second");
          },
        ],
        { failFast: false }
      )
    ).rejects.toThrow("first");
    expect(ran).toBe(2);
  });

  it("rejects immediately if the caller signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("pre-aborted"));
    await expect(
      parallelLimit([() => Promise.resolve(1)], { signal: ctrl.signal })
    ).rejects.toThrow("pre-aborted");
  });
});
