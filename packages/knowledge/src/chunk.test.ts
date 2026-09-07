import { describe, expect, it } from "vitest";
import { packParagraphs } from "./chunk";

const doc = (text: string) => ({ id: "d", text });

describe("packParagraphs", () => {
  it("packs paragraphs up to the budget and starts a new chunk rather than splitting one", () => {
    const chunk = packParagraphs(40);
    expect(chunk(doc(`alpha beta\n\ngamma delta\n\n${"x".repeat(30)}`))).toEqual([
      "alpha beta gamma delta",
      "x".repeat(30),
    ]);
  });

  it("emits an oversized paragraph whole rather than cutting mid-sentence", () => {
    // The bound is a packing target, not a storage limit: two halves of one sentence each
    // retrieve worse than the sentence does. Size at the effect boundary is the claim
    // check's job, not the chunker's.
    const long = "y".repeat(500);
    expect(packParagraphs(50)(doc(long))).toEqual([long]);
  });

  it("normalizes whitespace and drops empty paragraphs", () => {
    expect(packParagraphs(200)(doc("  one\n   two  \n\n\n\n   \n\nthree  "))).toEqual([
      "one two three",
    ]);
  });

  it("chunks an empty document to nothing", () => {
    expect(packParagraphs()(doc("   \n\n  "))).toEqual([]);
  });

  it("refuses a nonsense budget instead of looping or emitting one chunk per character", () => {
    expect(() => packParagraphs(0)).toThrow(TypeError);
    expect(() => packParagraphs(Number.NaN)).toThrow(TypeError);
  });
});
