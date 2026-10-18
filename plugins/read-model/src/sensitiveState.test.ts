import { describe, expect, it } from "vitest";
import {
  GUARD_WALK_BUDGET,
  type Lifted,
  NOTHING_LIFTED,
  SensitiveStateError,
  assertStateClean,
  isCipherEnvelope,
  isLiftable,
  walkBounded,
} from "./sensitiveState";

const ctx = { modelId: "m", executionId: "x-1", eventType: "STEP_COMPLETED", sequence: 3 };
const lifted = (strings: string[] = [], numbers: number[] = []): Lifted => ({
  strings: new Set(strings),
  numbers: new Set(numbers),
});
const refusal = (state: unknown, l: Lifted): SensitiveStateError => {
  try {
    assertStateClean(ctx, state, l);
  } catch (e) {
    return e as SensitiveStateError;
  }
  throw new Error("expected a SensitiveStateError");
};

describe("assertStateClean — the persist-time check (ADR 0132 D11)", () => {
  it("passes an ordinary status-shaped state", () => {
    expect(() =>
      assertStateClean(ctx, { status: "done", steps: 2, tags: ["a"] }, NOTHING_LIFTED)
    ).not.toThrow();
  });

  it("refuses a sealed envelope at any depth and reports where, not what", () => {
    const e = refusal(
      { a: { b: [{ __loomEnc: "loom/aes-256-gcm", ct: "zzzzzzzz" }] } },
      NOTHING_LIFTED
    );
    expect(e).toBeInstanceOf(SensitiveStateError);
    expect(e).toMatchObject({ reason: "sealed-envelope", statePath: "$.a.b[0]" });
    expect(e.message).not.toContain("zzzzzzzz");
  });

  it("treats a non-string or inherited __loomEnc as an ordinary value (ADR 0130 D2)", () => {
    expect(() => assertStateClean(ctx, { v: { __loomEnc: 1 } }, NOTHING_LIFTED)).not.toThrow();
    expect(() =>
      assertStateClean(ctx, { v: Object.create({ __loomEnc: "x" }) }, NOTHING_LIFTED)
    ).not.toThrow();
  });

  it("refuses a lifted string and names model, execution, event and path — never the value", () => {
    const secret = "alice@example.com";
    const e = refusal({ owner: { email: secret } }, lifted([secret]));
    expect(e).toMatchObject({ reason: "lifted-value", statePath: "$.owner.email" });
    expect(e.message).toContain('"m"');
    expect(e.message).toContain('"x-1"');
    expect(e.message).toContain("STEP_COMPLETED #3");
    expect(e.message).not.toContain(secret);
    expect(JSON.stringify(e.context)).not.toContain(secret);
  });

  it("refuses a lifted value used as an object KEY, without echoing the key", () => {
    const secret = "alice@example.com";
    const e = refusal({ byOwner: { [secret]: 1 } }, lifted([secret]));
    expect(e).toMatchObject({ reason: "lifted-value", statePath: "$.byOwner.<key>" });
    expect(e.message).not.toContain(secret);
  });

  it("refuses a lifted integer used as an object KEY, without echoing it", () => {
    const e = refusal({ byId: { "123456789": 1 } }, lifted([], [123456789]));
    expect(e).toMatchObject({ reason: "lifted-value", statePath: "$.byId.<key>" });
    expect(e.message).not.toContain("123456789");
  });

  it("refuses a lifted number", () => {
    expect(refusal({ n: [0, 123456789] }, lifted([], [123456789]))).toMatchObject({
      statePath: "$.n[1]",
    });
  });

  it("does not lift values too short to be meaningful (no false positives on 'ok' or 3)", () => {
    expect(isLiftable("ok")).toBe(false);
    expect(isLiftable(12345)).toBe(false);
    expect(isLiftable("abcdef")).toBe(true);
    expect(isLiftable(123456)).toBe(true);
    expect(isLiftable(true)).toBe(false);
    expect(isLiftable(1234567.5)).toBe(false);
    expect(isLiftable(-123456)).toBe(true);
  });

  it("fails closed when the state is too large to verify", () => {
    const e = refusal({ big: new Array(GUARD_WALK_BUDGET + 1).fill(0) }, NOTHING_LIFTED);
    expect(e.reason).toBe("unverifiable");
  });

  it("does not echo a lifted value embedded in a longer key, in message, statePath or stack", () => {
    const sec = "Alice@Example.com";
    const e = refusal({ byEmail: { [`t1:${sec}`]: { email: sec } } }, lifted([sec]));
    expect(e.statePath).toBe("$.byEmail.<key>.email");
    for (const text of [e.message, e.statePath, e.stack ?? ""]) {
      expect(text.toLowerCase()).not.toContain(sec.toLowerCase());
    }
    const plain = refusal({ byEmail: { k_a: { email: sec } } }, lifted([sec]));
    expect(plain.statePath).toBe("$.byEmail.k_a.email");
  });

  it("copies only the four named context fields", () => {
    const wide = { ...ctx, secret: "s3cretvalue" };
    try {
      assertStateClean(wide, { v: { __loomEnc: "x" } }, NOTHING_LIFTED);
    } catch (e) {
      const err = e as SensitiveStateError;
      expect(err.context).toEqual(ctx);
      expect(JSON.stringify(err.context)).not.toContain("s3cretvalue");
      return;
    }
    throw new Error("expected a SensitiveStateError");
  });

  it("does not lift floats, so a float-looking key passes", () => {
    expect(() => assertStateClean(ctx, { "1234567.5": 1 }, lifted([], [1234567]))).not.toThrow();
  });

  it("compares canonical decimal form both ways for values", () => {
    expect(refusal({ v: "123456789" }, lifted([], [123456789]))).toMatchObject({
      statePath: "$.v",
    });
    expect(refusal({ v: 123456789 }, lifted(["123456789"]))).toMatchObject({ statePath: "$.v" });
    expect(() => assertStateClean(ctx, { v: "0123456789" }, lifted([], [123456789]))).not.toThrow();
  });

  it("refuses a negative lifted integer", () => {
    expect(refusal({ v: [-123456789] }, lifted([], [-123456789]))).toMatchObject({
      statePath: "$.v[0]",
    });
  });

  it("refuses an envelope at the root and as a top-level array element", () => {
    expect(refusal({ __loomEnc: "a" }, NOTHING_LIFTED)).toMatchObject({
      reason: "sealed-envelope",
      statePath: "$",
    });
    expect(refusal([1, { __loomEnc: "a" }], NOTHING_LIFTED)).toMatchObject({ statePath: "$[1]" });
    expect(isCipherEnvelope([])).toBe(false);
  });

  it("walks exactly the budget and refuses one more; walkBounded reports exhaustion", () => {
    const fits = new Array(GUARD_WALK_BUDGET - 1).fill(0);
    expect(() => assertStateClean(ctx, fits, NOTHING_LIFTED)).not.toThrow();
    expect(() => assertStateClean(ctx, [...fits, 0], NOTHING_LIFTED)).toThrow(SensitiveStateError);
    let seen = 0;
    expect(walkBounded(fits, () => seen++)).toBe(true);
    expect(seen).toBe(GUARD_WALK_BUDGET);
    expect(walkBounded([...fits, 0], () => {})).toBe(false);
  });

  it("does not mutate the state", () => {
    const state = { a: [1, { b: "abcdefgh" }] };
    const copy = structuredClone(state);
    assertStateClean(ctx, state, lifted(["zzzzzzz"]));
    expect(state).toEqual(copy);
  });
});
