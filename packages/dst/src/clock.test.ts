import { describe, expect, it } from "vitest";
import { virtualClock } from "./clock";

describe("virtualClock", () => {
  it("starts at the given epoch and advances forward only", () => {
    const c = virtualClock(1000);
    expect(c.now()).toBe(1000);
    c.advanceBy(500);
    expect(c.now()).toBe(1500);
    c.advanceBy(-100); // ignored
    expect(c.now()).toBe(1500);
    c.advanceTo(1200); // in the past → ignored
    expect(c.now()).toBe(1500);
    c.advanceTo(2000);
    expect(c.now()).toBe(2000);
  });

  it("nextWake returns the soonest future wake and skips past ones", () => {
    const c = virtualClock(0);
    c.registerWake(50);
    c.registerWake(20);
    c.registerWake(-5); // past → ignored
    expect(c.nextWake()).toBe(20);
    c.advanceTo(20);
    expect(c.nextWake()).toBe(50); // 20 no longer strictly future
  });

  it("clearWake removes a pending wake (multiset-aware)", () => {
    const c = virtualClock(0);
    c.registerWake(30);
    c.registerWake(30); // two executions share a wake
    c.clearWake(30);
    expect(c.nextWake()).toBe(30); // still one left
    c.clearWake(30);
    expect(c.nextWake()).toBeUndefined();
  });
});
