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

  it("structural sharing: two paths under one prefix both transform, untouched subtrees are shared by reference", () => {
    const input = {
      creds: { user: "u", pass: "p" },
      untouched: { big: [1, 2, 3] },
    };
    const out = mapPaths(input, ["creds.user", "creds.pass"], (v) => `X${v}`) as typeof input;

    // Both sibling paths under `creds` were transformed on the SAME copied node.
    expect(out.creds).toEqual({ user: "Xu", pass: "Xp" });
    // The original is untouched (no shared mutation up the spine).
    expect(input.creds).toEqual({ user: "u", pass: "p" });
    // The untouched subtree is shared by reference (no needless deep clone).
    expect(out.untouched).toBe(input.untouched);
  });

  it("does not mutate the original even when arrays are on the spine", () => {
    const input = { items: [{ secret: "a" }, { secret: "b" }] };
    const out = mapPaths(input, ["items.0.secret"], () => "REDACTED") as typeof input;
    expect(out.items[0]?.secret).toBe("REDACTED");
    expect(input.items[0]?.secret).toBe("a"); // original array + element untouched
    expect(out.items[1]).toBe(input.items[1]); // untouched element shared
  });

  it("encrypts EVERY element behind a `[]` path, and only the marked field (#260)", () => {
    const key = randomBytes(32);
    const input = {
      people: [
        { ssn: "111-11-1111", id: "a" },
        { ssn: "222-22-2222", id: "b" },
      ],
      note: "plain",
    };
    const out = mapPaths(input, ["people[].ssn"], (v) => encryptValue(key, v)) as typeof input;

    expect(Array.isArray(out.people)).toBe(true);
    expect(out.people).toHaveLength(2);
    for (const [i, person] of out.people.entries()) {
      expect(hasEnvelope(person.ssn)).toBe(true);
      // Round-trips to the original plaintext — the whole point of encrypting at append.
      expect(decryptValue(key, person.ssn)).toBe(input.people[i]?.ssn);
    }
    // Unmarked siblings untouched.
    expect(out.people[0]?.id).toBe("a");
    expect(out.note).toBe("plain");
    // Input never mutated.
    expect(input.people[0]?.ssn).toBe("111-11-1111");
  });

  it("leaves a `[]` path alone when it does not resolve", () => {
    const input = { people: "not-an-array", other: 1 };
    expect(mapPaths(input, ["people[].ssn"], () => "X")).toEqual(input);
    expect(mapPaths({ other: 1 }, ["people[].ssn"], () => "X")).toEqual({ other: 1 });
  });
});
