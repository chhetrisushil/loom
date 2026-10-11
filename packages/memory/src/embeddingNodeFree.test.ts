import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@loom/core";
import { describe, expect, it } from "vitest";

// embedding.ts hashes with core's pure sha256Hex so browser bundles of @loom/memory carry no
// `node:crypto`. The digest feeds entry keys (`h:<hex>`), so it must equal node:crypto's.
describe("embedding hashing is node-free and byte-identical to node:crypto", () => {
  const samples = [
    "",
    "abc",
    "assistant\u0000123\u0000hello world",
    "héllo — 日本語 😀",
    "lone \ud800 surrogate \udc00 pair",
    "x".repeat(10_000),
  ];
  it.each(samples)("sha256Hex matches createHash (%#)", (s) => {
    expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
  });
  it("embedding.ts does not import a node: module", () => {
    const src = readFileSync(join(__dirname, "embedding.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']node:/);
  });
});
