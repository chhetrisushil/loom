import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptValue, encryptValue, hasEnvelope, mapPaths } from "./crypto";

describe("field-level AES-256-GCM envelope (K10.2)", () => {
  const key = randomBytes(32);

  it("round-trips arbitrary JSON values", () => {
    for (const value of ["ssn", 42, { a: [1, 2] }, null, true]) {
      expect(decryptValue(key, encryptValue(key, value))).toEqual(value);
    }
  });

  it("a wrong key fails (auth tag) — encryption is real, not obfuscation", () => {
    const env = encryptValue(key, "secret");
    expect(() => decryptValue(randomBytes(32), env)).toThrow();
  });

  it("decryptValue passes non-envelopes through untouched", () => {
    expect(decryptValue(key, "plain")).toBe("plain");
    expect(decryptValue(key, { a: 1 })).toEqual({ a: 1 });
  });

  it("hasEnvelope detects ciphertext anywhere in a structure", () => {
    expect(hasEnvelope({ output: { ssn: encryptValue(key, "x") } })).toBe(true);
    expect(hasEnvelope({ output: { ssn: "plain" } })).toBe(false);
  });

  it("mapPaths transforms only existing dot-paths, cloning (no input mutation)", () => {
    const input = { output: { ssn: "s", ok: true }, other: 1 };
    const out = mapPaths(input, ["output.ssn", "missing.path"], () => "X") as typeof input;
    expect(out.output.ssn).toBe("X");
    expect(out.output.ok).toBe(true);
    expect(out.other).toBe(1);
    expect(input.output.ssn).toBe("s"); // original untouched
  });
});
