import { describe, expect, it } from "vitest";
import { NEVER_SIGNAL, linkSignals, throwIfAborted, withTimeout } from "./signals";

describe("throwIfAborted", () => {
  it("is a no-op for undefined or non-aborted signals", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it("throws the signal reason when aborted", () => {
    const ctrl = new AbortController();
    const reason = new Error("stop");
    ctrl.abort(reason);
    expect(() => throwIfAborted(ctrl.signal)).toThrow(reason);
  });
});

describe("NEVER_SIGNAL", () => {
  it("is a shared, never-aborted signal", () => {
    expect(NEVER_SIGNAL.aborted).toBe(false);
  });
});

describe("linkSignals", () => {
  it("returns undefined when no signals are supplied", () => {
    expect(linkSignals(undefined, undefined)).toBeUndefined();
  });

  it("returns the single signal unchanged", () => {
    const s = new AbortController().signal;
    expect(linkSignals(undefined, s)).toBe(s);
  });

  it("aborts when any input aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const linked = linkSignals(a.signal, b.signal)!;
    expect(linked.aborted).toBe(false);
    b.abort(new Error("b failed"));
    expect(linked.aborted).toBe(true);
  });

  it("is already aborted if an input is already aborted", () => {
    const a = new AbortController();
    a.abort();
    const linked = linkSignals(a.signal, new AbortController().signal)!;
    expect(linked.aborted).toBe(true);
  });
});

describe("withTimeout", () => {
  it("aborts after the timeout elapses", async () => {
    const { signal, dispose } = withTimeout(5);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it("aborts immediately when the parent is already aborted", () => {
    const parent = new AbortController();
    parent.abort(new Error("parent"));
    const { signal, dispose } = withTimeout(1000, parent.signal);
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it("dispose() clears the timer so no late abort fires", async () => {
    const { signal, dispose } = withTimeout(5);
    dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(signal.aborted).toBe(false);
  });
});
