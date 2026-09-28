import { describe, expect, it } from "vitest";
import { compareExecutionIds } from "./executionIdOrder";

// The reference is UTF-8 byte order — what Postgres `COLLATE "C"` and SQLite BINARY compare.
const utf8 = (a: string, b: string): number =>
  Math.sign(Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));

describe("compareExecutionIds — code point order (EventStore SPI 2.0.0)", () => {
  it("agrees with UTF-8 byte order where JavaScript's default order does not", () => {
    // U+FF01 vs U+1F600: code units say the astral char is SMALLER (0xD83D < 0xFF01).
    expect("\u{1f600}" < "！").toBe(true);
    expect(compareExecutionIds("\u{1f600}", "！")).toBeGreaterThan(0);
    expect(utf8("\u{1f600}", "！")).toBe(1);
  });

  it("matches UTF-8 byte order on random ids over case, punctuation, BMP and astral chars", () => {
    const alphabet = [
      "A",
      "a",
      "Z",
      "z",
      "0",
      "9",
      "-",
      "_",
      ".",
      ":",
      "~",
      "é",
      "！",
      "",
      "\u{1f600}",
      "\u{10ffff}",
    ];
    let seed = 42;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const id = (): string =>
      Array.from({ length: 1 + rand(5) }, () => alphabet[rand(alphabet.length)]).join("");
    for (let i = 0; i < 5000; i++) {
      const a = id();
      const b = id();
      expect(Math.sign(compareExecutionIds(a, b))).toBe(utf8(a, b));
    }
  });
});
