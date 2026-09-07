import { tainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { UngroundedCitationError, assertGrounded, checkCitations } from "./citations";
import type { Passage } from "./types";

const passage = (docId: string, index = 0): Passage => ({
  docId,
  index,
  text: tainted(`passage ${index} of ${docId}`, `knowledge:runbooks:${docId}`),
});

describe("checkCitations", () => {
  it("splits claimed citations into grounded and fabricated", () => {
    const check = checkCitations(["RB-101", "RB-999"], [passage("RB-101"), passage("RB-204")]);
    // RB-999 was never retrieved, so it was never read: this is not a misreading of a
    // passage, it is a document that played no part in the answer.
    expect(check).toEqual({
      grounded: ["RB-101"],
      ungrounded: ["RB-999"],
      unused: ["RB-204"],
    });
  });

  it("counts a document once however many of its passages were retrieved", () => {
    const check = checkCitations(
      ["RB-101", "RB-101"],
      [passage("RB-101", 0), passage("RB-101", 1)]
    );
    expect(check.grounded).toEqual(["RB-101"]);
    expect(check.unused).toEqual([]);
  });

  it("reports grounded ids in retrieval order, not in the order the model listed them", () => {
    const check = checkCitations(["RB-204", "RB-101"], [passage("RB-101"), passage("RB-204")]);
    expect(check.grounded).toEqual(["RB-101", "RB-204"]);
  });

  it("treats an answer with no citations as citing nothing, not as citing everything", () => {
    const check = checkCitations([], [passage("RB-101")]);
    expect(check).toEqual({ grounded: [], ungrounded: [], unused: ["RB-101"] });
  });

  it("compares ids exactly", () => {
    // A corpus's ids are its own namespace; normalizing case or punctuation here would be
    // guessing at it, and would silently accept a citation to a document that is not there.
    expect(checkCitations(["rb-101"], [passage("RB-101")]).ungrounded).toEqual(["rb-101"]);
  });
});

describe("assertGrounded", () => {
  it("returns the grounded ids when every citation checks out", () => {
    expect(assertGrounded(["RB-101"], [passage("RB-101"), passage("RB-204")])).toEqual(["RB-101"]);
  });

  it("throws on a fabricated citation, naming what was actually retrieved", () => {
    // The failure mode: an answer that reads as sourced, names a plausible runbook, and
    // cannot be traced to anything — the citation making it MORE trusted, not less.
    try {
      assertGrounded(["RB-404"], [passage("RB-101")]);
      expect.unreachable("expected an UngroundedCitationError");
    } catch (err) {
      expect(err).toBeInstanceOf(UngroundedCitationError);
      expect((err as UngroundedCitationError).ungrounded).toEqual(["RB-404"]);
      expect((err as UngroundedCitationError).message).toContain("RB-101");
    }
  });

  it("throws when an answer cites anything after retrieving nothing", () => {
    expect(() => assertGrounded(["RB-101"], [])).toThrow(/retrieved: none/);
  });
});
