import { describe, expect, it } from "vitest";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import {
  DEFAULT_FOLD_CACHE_ENTRIES,
  MAX_GET_MANY,
  READ_MODEL_STORE_SPI_VERSION,
  assertManyKeys,
  foldedSelectorColumn,
} from "./types";

describe("folded SPI types (ADR 0132 D6/D7)", () => {
  it("bumps the SPI to 1.2.0", () => {
    expect(READ_MODEL_STORE_SPI_VERSION).toBe("1.2.0");
  });

  it("accepts an empty list and a full page of keys", () => {
    expect(() => assertManyKeys([], "getMany")).not.toThrow();
    expect(() =>
      assertManyKeys(
        Array.from({ length: MAX_GET_MANY }, (_, i) => `k${i}`),
        "getMany"
      )
    ).not.toThrow();
  });

  it("refuses more than MAX_GET_MANY keys with a RangeError", () => {
    const keys = Array.from({ length: MAX_GET_MANY + 1 }, (_, i) => `k${i}`);
    expect(() => assertManyKeys(keys, "getMany")).toThrow(RangeError);
  });

  it("refuses blank keys: a computed-but-empty key must not match everything or nothing", () => {
    expect(() => assertManyKeys(["a", ""], "getManyByKey")).toThrow(TypeError);
  });

  it("defaults the per-node fold cache to 1024 entries (ADR 0132 D15)", () => {
    expect(DEFAULT_FOLD_CACHE_ENTRIES).toBe(1024);
  });

  it("maps a purge selector to the one column it names (shared by the SQL backends)", () => {
    expect(foldedSelectorColumn({ executionId: "x-1" })).toEqual(["execution_id", "x-1"]);
    expect(foldedSelectorColumn({ key: "d1" })).toEqual(["app_key", "d1"]);
    expect(foldedSelectorColumn({ scope: "u1" })).toEqual(["scope", "u1"]);
  });
});

it("the in-memory reference implements every folded method (so the kit does not silently skip)", () => {
  const s = new InMemoryReadModelStore();
  for (const m of [
    "beginFold",
    "applyFolded",
    "getFolded",
    "getFoldedByKey",
    "purgeFolded",
  ] as const) {
    expect(typeof s[m]).toBe("function");
  }
});
